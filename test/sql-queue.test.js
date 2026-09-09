// Runs with:  node --test test/sql-queue.test.js

var test = require('node:test');
var assert = require('node:assert');
var { SqlQueue } = require('../lib/queue');
var { encrypt } = require('../isomorphic/crypto');

function sleep(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }

// Executor that succeeds/fails based on item hints so tests stay deterministic.
//   sql contains 'FAIL'    → throws
//   sql contains 'FAIL_1'  → throws only when item.meta.rows.length===1 (bisect-friendly)
//   sql contains 'RETRY'   → throws until item.attempt >= (item.meta.recoverAt)
//   otherwise              → success
function makeMockExecutor(events) {
  return async function(item, _conn) {
    events.push({ attempt: item.attempt, sql: item.sql, rows: (item.meta && item.meta.rows && item.meta.rows.length) || 0 });
    if (item.sql.includes('FAIL_1') && item.meta.rows.length === 1) throw new Error('row-level failure');
    if (item.sql.includes('FAIL')) throw new Error('generic failure');
    if (item.sql.includes('RETRY') && item.attempt < (item.meta.recoverAt || 3)) throw new Error('transient');
  };
}

test('basic enqueue + execute + drain + stats', async function() {
  var events = [];
  var q = new SqlQueue({
    executor: makeMockExecutor(events),
    connections: { c: { host: 'x' } },
    concurrency: 2
  });

  for (var i = 0; i < 5; i++) {
    await q.addToQueue({
      movementId: 'm1',
      connection: 'c',
      sql:        'INSERT ' + i,
      meta:       { rows: [{ id: i }], rowCount: 1 }
    });
  }
  await q.drain();
  q.stop();

  var s = q.stats('m1');
  assert.strictEqual(s.completed, 5);
  assert.strictEqual(s.dropped, 0);
  assert.strictEqual(s.aborted, false);
  assert.strictEqual(events.length, 5);
});

test('backpressure: addToQueue awaits when over memory cap', async function() {
  var events = [];
  var slowExecutor = async function(item, _c) {
    events.push(item.id);
    await sleep(40);
  };
  var q = new SqlQueue({
    executor: slowExecutor,
    connections: { c: { host: 'x' } },
    concurrency: 1,
    maxMemoryMB: 0.001            // ~1KB high water, ~768B low water — trips fast
  });

  // Build a fat item so we exceed cap after very few enqueues.
  var bigRows = Array.from({ length: 200 }, function(i) { return { id: i, pad: 'x'.repeat(10) }; });
  var t0 = Date.now();
  var timings = [];
  for (var i = 0; i < 5; i++) {
    timings.push(Date.now() - t0);
    await q.addToQueue({ movementId: 'm2', connection: 'c', sql: 'INSERT ' + i, meta: { rows: bigRows, rowCount: bigRows.length } });
  }
  // At least one of the enqueues should have waited noticeably.
  var maxGap = 0;
  for (var j = 1; j < timings.length; j++) maxGap = Math.max(maxGap, timings[j] - timings[j - 1]);
  assert.ok(maxGap > 20, 'expected backpressure to insert a wait, got maxGap=' + maxGap);

  await q.drain();
  q.stop();
});

test('bisect: batch failure splits recursively down to a size-1 error', async function() {
  var events = [];
  var q = new SqlQueue({
    executor: makeMockExecutor(events),
    connections: { c: { host: 'x' } },
    concurrency: 1,
    maxAttempts: 1                   // fail fast; go straight to bisect
  });

  var rows = Array.from({ length: 4 }, function(i) { return { id: i }; });
  await q.addToQueue({
    movementId: 'm3',
    connection: 'c',
    meta: {
      rows: rows,
      rowsToSql: function(rs) { return 'INSERT FAIL_1 -- ' + rs.length + ' rows'; }
    }
  });
  await q.drain();
  q.stop();

  var s = q.stats('m3');
  // 4 size-1 items each go to error table → 4 drops
  assert.strictEqual(s.dropped, 4);
  assert.strictEqual(s.completed, 0);
  // Enough events to demonstrate bisection happened.
  assert.ok(events.length >= 7, 'expected bisection to produce >=7 attempts, got ' + events.length);
});

test('5 consecutive drops → auto-abort', async function() {
  var aborted = null;
  var q = new SqlQueue({
    executor: async function(item, _c) { throw new Error('always fails'); },
    connections: { c: {} },
    concurrency: 1,
    maxAttempts: 1,
    maxConsecutiveDrops: 5,
    onMovementAbort: function(info) { aborted = info; }
  });

  // 6 items — after the 5th drop, movement auto-aborts.
  // Bisect is not possible (rowCount=1 each), so each goes straight to error table.
  for (var i = 0; i < 10; i++) {
    await q.addToQueue({
      movementId: 'm4',
      connection: 'c',
      sql:        'INSERT FAIL ' + i,
      meta:       { rows: [{ id: i }], rowCount: 1 }
    });
  }
  await q.drain();
  q.stop();

  var s = q.stats('m4');
  assert.strictEqual(s.aborted, true);
  assert.strictEqual(aborted && aborted.reason, 'consecutive_drops_exceeded');
  // Not every item processed — some dropped as queued-aborted.
  assert.ok(s.dropped >= 5);
});

test('abort(movementId) drops only that movement, others keep running', async function() {
  var events = [];
  var q = new SqlQueue({
    executor: async function(item, _c) {
      events.push(item.movementId + ':' + item.id);
      await sleep(20);
    },
    connections: { c: {} },
    concurrency: 1
  });

  // Interleave: alternating m5-good and m6-abort
  for (var i = 0; i < 6; i++) {
    await q.addToQueue({ movementId: 'm5', connection: 'c', sql: 'INSERT ' + i, meta: { rows: [{ id: i }] } });
    await q.addToQueue({ movementId: 'm6', connection: 'c', sql: 'INSERT ' + i, meta: { rows: [{ id: i }] } });
  }
  // Kill m6 while items are still queued.
  q.abort('m6', 'user_requested');
  await q.drain();
  q.stop();

  var m5 = q.stats('m5');
  var m6 = q.stats('m6');
  assert.strictEqual(m5.completed, 6);
  assert.strictEqual(m6.completed + m6.dropped, 6);
  assert.strictEqual(m6.aborted, true);
});

test('encrypted connection resolves via crypto', async function() {
  var key = 'test-key-that-is-long-enough';
  var payload = JSON.stringify({ host: 'localhost', port: 5432, user: 'u' });
  var encrypted = await encrypt(payload, key);

  var seen = null;
  var q = new SqlQueue({
    executor: async function(item, conn) { seen = conn; },
    connections:   { primary: encrypted },
    encryptionKey: key,
    concurrency:   1
  });

  await q.addToQueue({ movementId: 'm7', connection: 'primary', sql: 'INSERT 1', meta: { rows: [{}] } });
  await q.drain();
  q.stop();

  assert.deepStrictEqual(seen, { host: 'localhost', port: 5432, user: 'u' });
});

test('retry uses configured delay list and eventually succeeds', async function() {
  var events = [];
  var q = new SqlQueue({
    executor: makeMockExecutor(events),
    connections: { c: {} },
    concurrency: 1,
    maxAttempts: 4,
    retryDelaysMs: [5, 5, 5]      // small so the test is fast
  });

  await q.addToQueue({
    movementId: 'm8',
    connection: 'c',
    sql:        'INSERT RETRY 1',
    meta:       { rows: [{}], rowCount: 1, recoverAt: 3 }
  });
  await q.drain();
  q.stop();

  var s = q.stats('m8');
  assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.dropped, 0);
  // 3 events: attempts 1, 2, 3 (recoverAt=3)
  assert.strictEqual(events.length, 3);
});

// A deterministic failure (a NOT NULL violation, say) is dropped on the first
// attempt rather than retried — see lib/sql-error.js. Two things follow, and
// both used to be wrong.
test('deterministic errors bisect immediately instead of waiting out the backoff', async function() {
  var attempts = [];
  var q = new SqlQueue({
    connections: { c: {} },
    // 5s/15s/45s if this were treated as transient — the test would not finish.
    retryDelaysMs: [5000, 15000, 45000],
    maxConsecutiveDrops: 100,
    executor: async function(item) {
      attempts.push(item.meta.rows.length);
      var err = new Error('null value in column "amount" violates not-null constraint');
      err.code = '23502';                  // postgres SQLSTATE: not_null_violation
      throw err;
    }
  });
  var started = Date.now();
  await q.addToQueue({
    movementId: 'm1', connection: 'c',
    meta: { rows: [1, 2, 3, 4], rowCount: 4, rowsToSql: function(r) { return 'INSERT ' + r.length; } }
  });
  await q.drain();
  q.stop();

  assert.ok(Date.now() - started < 3000, 'must not sit in the retry backoff for a verdict it already has');
  assert.equal(q.stats('m1').dropped, 4, 'every row accounted for');
  // 4 → 2+2 → 1+1+1+1, each tried exactly once.
  assert.deepEqual(attempts.sort(), [1, 1, 1, 1, 2, 2, 4]);
});

test('drain() returns when items arrive after an abort', async function() {
  // THE HANG THIS GUARDS AGAINST: abort() clears what is queued at that
  // instant — and the producer feeding the queue does not stop. The uploader's
  // spool keeps calling addToQueue for every batch it reads (see uploader's
  // onBatch, which never consults stats().aborted), so items land in an
  // already-aborted movement. The worker loop skips those, and nothing else
  // removed them: they sat in _items forever and drain() waited on a queue
  // that could never empty. The movement had done all the work it was ever
  // going to do, and hung there with no summary line ever written.
  //
  // Seen for real on a 1000-row movement into a NOT NULL column, once
  // deterministic errors stopped being retried — the old 5s/15s/45s backoff
  // had been slowing the producer down enough to usually hide it.
  var q = new SqlQueue({
    connections: { c: {} },
    concurrency: 1,
    executor: async function() { /* never reached — the movement aborts first */ }
  });

  q.abort('m1', 'test');
  for (var i = 0; i < 3; i++) {
    await q.addToQueue({
      movementId: 'm1', connection: 'c',
      meta: { rows: [1, 2], rowCount: 2, rowsToSql: function(r) { return 'INSERT ' + r.length; } }
    });
  }
  assert.equal(q.stats().queued, 3, 'the producer did enqueue past the abort');

  var winner = await Promise.race([
    q.drain().then(function() { return 'drained'; }),
    sleep(4000).then(function() { return 'timeout'; })
  ]);
  q.stop();

  assert.equal(winner, 'drained', 'drain() must not hang on items belonging to an aborted movement');
  assert.equal(q.stats().queued, 0, 'and they must not be left sitting in the queue');
  assert.equal(q.stats('m1').dropped, 6, 'those rows are lost — the count has to say so');
});
