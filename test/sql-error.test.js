// Runs with:  node --test test/sql-error.test.js
//
// Two halves. The TABLE tests pin the mapping itself. The LIVE tests provoke
// the real error from a real server and classify what it actually threw —
// because the whole file rests on a claim about error SHAPES (postgres puts a
// SQLSTATE on .code, mysql an errno, mssql a .number), and a claim about
// shapes is worth nothing until a server has produced one.
//
// Live tests skip themselves when their server is not reachable, so the file
// is runnable anywhere. Postgres: PGHOST/PGPORT/PGUSER/PGPASSWORD.
// MySQL: MYSQL_HOST/PORT/USER/PASSWORD. Defaults match the local dev boxes.

var test = require('node:test');
var assert = require('node:assert');
var net = require('node:net');
var { classifySqlError, isRetryableSqlError } = require('../lib/sql-error');

// ── the mapping ─────────────────────────────────────────────────────────

test('postgres: constraint and data errors are deterministic', function() {
  ['23502', '23505', '23503', '23514', '22P02', '22001', '42703', '42P01'].forEach(function(code) {
    var v = classifySqlError({ code: code });
    assert.equal(v.retryable, false, code + ' must not be retried');
    assert.equal(v.kind, 'deterministic');
    assert.equal(v.dialect, 'postgres');
    assert.equal(v.code, code);
  });
});

test('postgres: deadlock, serialization and connection errors are transient', function() {
  ['40001', '40P01', '08006', '53300', '57P03'].forEach(function(code) {
    var v = classifySqlError({ code: code });
    assert.equal(v.retryable, true, code + ' must be retried');
    assert.equal(v.kind, 'transient');
  });
});

test('mysql: classified by errno, with or without the ER_ name', function() {
  assert.equal(classifySqlError({ code: 'ER_BAD_NULL_ERROR', errno: 1048 }).kind, 'deterministic');
  assert.equal(classifySqlError({ errno: 1048 }).kind, 'deterministic');          // name absent
  assert.equal(classifySqlError({ code: 'ER_DUP_ENTRY', errno: 1062 }).retryable, false);
  assert.equal(classifySqlError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 }).retryable, true);
  assert.equal(classifySqlError({ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }).kind, 'transient');
  assert.equal(classifySqlError({ code: 'PROTOCOL_CONNECTION_LOST' }).kind, 'transient');
});

test('mssql: classified by .number', function() {
  assert.equal(classifySqlError({ number: 515 }).kind, 'deterministic');   // cannot insert NULL
  assert.equal(classifySqlError({ number: 2627 }).retryable, false);       // unique violation
  assert.equal(classifySqlError({ number: 245 }).retryable, false);        // conversion failed
  assert.equal(classifySqlError({ number: 1205 }).kind, 'transient');      // deadlock victim
  assert.equal(classifySqlError({ number: 40501 }).retryable, true);       // azure busy
  assert.equal(classifySqlError({ number: 515 }).dialect, 'mssql');
});

test('mysql 1205 and mssql 1205 are different errors, both transient', function() {
  // Same number, different meaning (lock wait timeout vs deadlock victim) —
  // and the shapes keep them apart, which is the point of not needing dbType.
  assert.equal(classifySqlError({ errno: 1205 }).dialect, 'mysql');
  assert.equal(classifySqlError({ number: 1205 }).dialect, 'mssql');
});

test('socket-level failures are transient in any dialect', function() {
  ['ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED'].forEach(function(code) {
    assert.equal(classifySqlError({ code: code }).retryable, true);
  });
});

test('anything unrecognised is retried — the default cannot be the one that loses rows', function() {
  assert.equal(classifySqlError(new Error('something nobody has seen')).kind, 'unknown');
  assert.equal(classifySqlError(new Error('x')).retryable, true);
  assert.equal(classifySqlError(null).retryable, true);
  assert.equal(classifySqlError({ code: '99999' }).kind, 'unknown');       // valid SQLSTATE shape, unknown class
  assert.equal(classifySqlError({ code: 'ER_SOMETHING_NEW' }).dialect, 'mysql');
  assert.equal(isRetryableSqlError({ code: 'ER_SOMETHING_NEW' }), true);
});

// ── live servers ────────────────────────────────────────────────────────

function reachable(host, port) {
  return new Promise(function(res) {
    var s = net.createConnection({ host: host, port: port });
    var done = function(ok) { try { s.destroy(); } catch (_) {} res(ok); };
    s.setTimeout(1200);
    s.on('connect', function() { done(true); });
    s.on('timeout', function() { done(false); });
    s.on('error', function() { done(false); });
  });
}

var PG = { host: process.env.PGHOST || 'localhost', port: parseInt(process.env.PGPORT || '5435', 10),
           user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres',
           database: process.env.PGDATABASE || 'postgres' };

test('LIVE postgres: real server errors classify correctly', async function(t) {
  if (!await reachable(PG.host, PG.port)) return t.skip('no postgres at ' + PG.host + ':' + PG.port);
  var pg;
  try { pg = require('pg'); } catch (_) { return t.skip('pg not resolvable from this package'); }

  var c = new pg.Client(PG);
  try { await c.connect(); } catch (e) { return t.skip('postgres refused the connection: ' + e.message); }
  try {
  var tbl = '__sqlerr_probe_' + process.pid;
  await c.query('CREATE TEMP TABLE ' + tbl + ' (id int primary key, amount numeric NOT NULL)');
  await c.query('INSERT INTO ' + tbl + ' VALUES (1, 5)');

  async function classifyOf(sql) {
    try { await c.query(sql); assert.fail('expected ' + sql + ' to fail'); }
    catch (err) { return classifySqlError(err); }
  }

  var notNull = await classifyOf('INSERT INTO ' + tbl + ' VALUES (2, NULL)');
  assert.equal(notNull.code, '23502');
  assert.equal(notNull.retryable, false, 'a NOT NULL violation is the same every time');

  var dup = await classifyOf('INSERT INTO ' + tbl + ' VALUES (1, 9)');
  assert.equal(dup.code, '23505');
  assert.equal(dup.retryable, false);

  var badCast = await classifyOf('INSERT INTO ' + tbl + " VALUES ('abc', 1)");
  assert.equal(badCast.retryable, false);
  assert.equal(badCast.kind, 'deterministic');

  var noColumn = await classifyOf('SELECT nope FROM ' + tbl);
  assert.equal(noColumn.code, '42703');
  assert.equal(noColumn.retryable, false);

  } finally { await c.end(); }

  // A server that is not there is transient by any reading.
  var dead = new pg.Client(Object.assign({}, PG, { port: 1 }));
  try { await dead.connect(); assert.fail('expected a connection failure'); }
  catch (err) { assert.equal(classifySqlError(err).retryable, true); }
});

var MY = { host: process.env.MYSQL_HOST || 'localhost', port: parseInt(process.env.MYSQL_PORT || '3306', 10),
           user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || 'break_karo' };
// mysql refuses a TEMPORARY TABLE with no database selected, so one has to be
// named — the same scratch database the driver integration tests use.
var MY_DB = process.env.MYSQL_DATABASE || 'xeplr_actions_test';

test('LIVE mysql: real server errors classify correctly', async function(t) {
  if (!await reachable(MY.host, MY.port)) return t.skip('no mysql at ' + MY.host + ':' + MY.port);
  var mysql;
  try { mysql = require('mysql2/promise'); } catch (_) { return t.skip('mysql2 not resolvable from this package'); }

  var c;
  try { c = await mysql.createConnection(MY); } catch (e) { return t.skip('mysql refused the connection: ' + e.message); }
  // Closed on every path — a test that fails mid-way must not also leave the
  // runner hanging on an open socket, which reads as a timeout rather than as
  // the assertion that actually failed.
  try {
    await c.query('CREATE DATABASE IF NOT EXISTS ' + MY_DB);
    await c.query('USE ' + MY_DB);
    var tbl = '__sqlerr_probe_' + process.pid;
    await c.query('CREATE TEMPORARY TABLE ' + tbl + ' (id int primary key, amount decimal(10,2) NOT NULL)');
    await c.query('INSERT INTO ' + tbl + ' VALUES (1, 5)');

    var classifyOf = async function(sql) {
      try { await c.query(sql); assert.fail('expected ' + sql + ' to fail'); }
      catch (err) { return classifySqlError(err); }
    };

    var notNull = await classifyOf('INSERT INTO ' + tbl + ' VALUES (2, NULL)');
    assert.equal(notNull.dialect, 'mysql');
    assert.equal(notNull.retryable, false, 'errno ' + notNull.code + ' should be deterministic');

    var dup = await classifyOf('INSERT INTO ' + tbl + ' VALUES (1, 9)');
    assert.equal(dup.retryable, false);

    var noColumn = await classifyOf('SELECT nope FROM ' + tbl);
    assert.equal(noColumn.retryable, false);
  } finally {
    await c.end();
  }
});

// MSSQL has no live counterpart here — nothing was listening on 1433 when this
// was written, so its numbers come from the documented set and are covered by
// the table test above. Bring a server up and this file is the place to add
// the same three provocations (515, 2627, 245).
