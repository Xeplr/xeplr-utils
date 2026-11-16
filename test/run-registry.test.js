// RunStore + RunRegistry: a run followed and stopped from ANOTHER process.
// Two real Node processes (test/fixtures/runProcess.js) share one Redis, as
// two API workers do: a run started in one is seen and stopped from the
// other. The memory store does the same within one process. Redis tests
// skip, saying so, when no Redis answers.
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var cluster = require('cluster');
var { fork } = require('child_process');
var RunStore = require('../lib/runStore');
var RunRegistry = require('../lib/runRegistry');

var PREFIX = 'xruns-test-' + process.pid + '-' + Date.now().toString(36);

function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function redisUp() {
  process.env.REDIS_PREFIX = process.env.REDIS_PREFIX || ('xeplr-utils-test-' + process.pid + ':');
  try { await require('../lib/cache').getClient().ping(); return true; } catch (e) { return false; }
}

/** A child process running a registry; ask(cmd, args) → its answer. */
function startProcess() {
  var child = fork(path.join(__dirname, 'fixtures', 'runProcess.js'), [], {
    env: Object.assign({}, process.env, { RUNS_TEST_PREFIX: PREFIX })
  });
  var seq = 0, waiting = new Map();
  var up = new Promise(function(resolve) {
    child.on('message', function(m) {
      if (m.up) return resolve();
      var w = waiting.get(m.reply);
      if (w) { waiting.delete(m.reply); w(m.value); }
    });
  });
  return {
    child: child,
    up: up,
    ask: function(cmd, args) {
      var n = ++seq;
      return new Promise(function(resolve) { waiting.set(n, resolve); child.send(Object.assign({ cmd: cmd, seq: n }, args || {})); });
    }
  };
}

async function until(fn, ms) {
  var end = Date.now() + (ms || 5000);
  for (;;) {
    var v = await fn();
    if (v || Date.now() > end) return v;
    await wait(50);
  }
}

test('redis: a run started in one process is followed and stopped from another', async function(t) {
  if (!(await redisUp())) { t.skip('no Redis available'); return; }
  var a = startProcess(), b = startProcess();
  try {
    await a.up; await b.up;
    var pids = [await a.ask('ready'), await b.ask('ready')];
    assert.notEqual(pids[0], pids[1], 'two processes');

    var id = await a.ask('start', { userId: 'u1' });
    assert.match(id, /^tst_/);
    var seen = await until(async function() {
      var v = await b.ask('view', { id: id, userId: 'u1' });
      return v && v.progress && v.progress.round >= 2 ? v : null;
    });
    assert.ok(seen, 'the other process sees it, and how far it has got');
    assert.equal(seen.status, 'running');
    assert.equal(seen.kind, 'test');
    assert.equal(seen.userId, undefined, 'whose it is is not shown');
    assert.equal(await b.ask('view', { id: id, userId: 'u2' }), null, 'nobody else sees it');
    assert.equal(await b.ask('stop', { id: id, userId: 'u2' }), false, 'nobody else stops it');

    assert.equal(await b.ask('stop', { id: id, userId: 'u1', reason: 'Stopped from B' }), true, 'stopped from the other process');
    var ended = await until(async function() {
      var v = await b.ask('view', { id: id, userId: 'u1' });
      return v && v.status !== 'running' ? v : null;
    });
    assert.equal(ended.status, 'stopped', 'the work in A stopped');
    assert.equal(ended.error, 'Stopped from B', 'with the reason given in B');
    assert.deepEqual(await a.ask('view', { id: id, userId: 'u1' }), ended, 'both processes say the same');
    var heard = await a.ask('heard');
    assert.equal(heard[heard.length - 1], 'stopped', 'onChange heard the ending where the work ran');
    assert.equal(await b.ask('stop', { id: id, userId: 'u1' }), false, 'an ended run is not stopped again');

    // One that ends by itself: its result is seen from the other process.
    var done = await a.ask('start', { userId: 'u1', rounds: 3 });
    var fin = await until(async function() {
      var v = await b.ask('view', { id: done, userId: 'u1' });
      return v && v.status === 'complete' ? v : null;
    });
    assert.deepEqual(fin.result, { rounds: 3 });
    assert.equal(await b.ask('view', { id: 'tst_nope', userId: 'u1' }), null);
  } finally {
    // Each closes its Redis connections and exits; it does not answer.
    a.ask('exit'); b.ask('exit');
    await Promise.all([a, b].map(function(p) {
      return new Promise(function(resolve) { p.child.once('exit', resolve); setTimeout(function() { p.child.kill(); resolve(); }, 2000); });
    }));
  }
});

test('memory: one process — followed, stopped, its result read', async function() {
  var runs = new RunRegistry({ name: 'mem', idPrefix: 'm_' });
  var said = [];
  var id = runs.start(async function(onProgress, signal) {
    for (var i = 0; i < 1000; i++) {
      if (signal.aborted) throw new Error('aborted');
      onProgress({ i: i });
      await wait(10);
    }
  }, { userId: 7, kind: 'check', onChange: function(v) { said.push(v.status); } });
  await wait(30);
  var v = await runs.view(id, '7');
  assert.equal(v.status, 'running', 'a number user id and its string are the same person');
  assert.equal(await runs.stop(id, 'someone else'), false);
  assert.equal(await runs.stop(id, 7, 'Enough'), true);
  var ended = await until(async function() { var x = await runs.view(id, 7); return x.status !== 'running' ? x : null; });
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.error, 'Enough');
  assert.equal(said[said.length - 1], 'stopped');

  var ok = runs.start(async function() { return { n: 1 }; }, { userId: 7 });
  var fin = await until(async function() { var x = await runs.view(ok, 7); return x.status !== 'running' ? x : null; });
  assert.deepEqual(fin.result, { n: 1 });
  var bad = runs.start(async function() { throw new Error('broke'); }, { userId: 7 });
  var failed = await until(async function() { var x = await runs.view(bad, 7); return x.status !== 'running' ? x : null; });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'broke');
});

test('a time limit stops the run, saying why', async function() {
  var runs = new RunRegistry({ name: 'limit' });
  var id = runs.start(async function(onProgress, signal) {
    while (!signal.aborted) await wait(5);
    throw new Error('aborted');
  }, { userId: 'u', timeLimitMs: 40, timeLimitMessage: 'Too long.' });
  var ended = await until(async function() { var x = await runs.view(id, 'u'); return x.status !== 'running' ? x : null; });
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.error, 'Too long.');
});

test('RunStore.fromEnv: memory unless told; refuses an unset store in a cluster worker, naming the setting', function() {
  var was = process.env.XEPLR_RUNS_STORE;
  try {
    delete process.env.XEPLR_RUNS_STORE;
    assert.equal(RunStore.fromEnv().mode, 'memory');
    process.env.XEPLR_RUNS_STORE = 'redis';
    assert.equal(RunStore.fromEnv().mode, 'redis');
    process.env.XEPLR_RUNS_STORE = 'disk';
    assert.throws(function() { RunStore.fromEnv(); }, /XEPLR_RUNS_STORE must be redis or memory/);
    delete process.env.XEPLR_RUNS_STORE;
    var real = Object.getOwnPropertyDescriptor(cluster, 'isWorker');
    Object.defineProperty(cluster, 'isWorker', { value: true, configurable: true });
    try {
      assert.throws(function() { RunStore.fromEnv(); }, /XEPLR_RUNS_STORE is not set, and this process is one of several/);
    } finally {
      if (real) Object.defineProperty(cluster, 'isWorker', real); else delete cluster.isWorker;
    }
  } finally {
    if (was === undefined) delete process.env.XEPLR_RUNS_STORE; else process.env.XEPLR_RUNS_STORE = was;
  }
});

test('RunStore memory: records, finals, claims and small values, each expiring', async function() {
  var s = new RunStore({ prefix: 'p' });
  assert.equal(s.available(), true);
  assert.equal(s.key('run', 'x'), 'p:run:x');
  await s.save({ id: 'r1', status: 'running' }, 1);
  assert.deepEqual(await s.load('r1'), { id: 'r1', status: 'running' });
  assert.equal(await s.load(null), null);
  await s.rememberFinal('u', { runId: 'r1' });
  assert.deepEqual(await s.recentFinals('u'), [{ runId: 'r1' }]);
  assert.deepEqual(await s.recentFinals('nobody'), []);
  assert.equal(await s.claim('job', 1), true);
  assert.equal(await s.claim('job', 1), false, 'one at a time');
  await s.release('job');
  assert.equal(await s.claim('job', 1), true);
  await s.setJson('board:b', ['r1']);
  assert.deepEqual(await s.getJson('board:b', []), ['r1']);
  assert.deepEqual(await s.getJson('board:none', []), []);
  var heard = [];
  s.onStop(function(m) { heard.push(m.id); });
  assert.equal(await s.requestStop('k', 'r1'), true);
  assert.deepEqual(heard, ['r1'], 'a stop asked for here is heard here');
  await s.listening();
  await s.save({ id: 'short' }, 0.05);
  await wait(80);
  assert.equal(await s.load('short'), null, 'gone after its seconds');
  await s.close();
});

test('RunStore redis without a client: a no-op, as one process behaves', async function() {
  var s = new RunStore({ store: 'redis', client: function() { return null; } });
  assert.equal(s.available(), false);
  assert.equal(await s.save({ id: 'x' }), false);
  assert.equal(await s.load('x'), null);
  assert.equal(await s.requestStop('k', 'x'), false);
  assert.equal(await s.claim('c', 1), null);
  assert.deepEqual(await s.recentFinals('u'), []);
  assert.deepEqual(await s.getJson('j', 'fallback'), 'fallback');
  s.onStop(function() {});
  await s.close();
});

test('RunStore redis: shared records, finals, claims; a result too large to share says so', async function(t) {
  if (!(await redisUp())) { t.skip('no Redis available'); return; }
  var one = new RunStore({ store: 'redis', prefix: PREFIX + '-direct' });
  var two = new RunStore({ store: 'redis', prefix: PREFIX + '-direct' });
  try {
    await one.save({ id: 'r', status: 'complete', result: { n: 1 } });
    assert.deepEqual(await two.load('r'), { id: 'r', status: 'complete', result: { n: 1 } });
    // Random bytes do not compress: past the limit, kept without the result.
    var big = require('crypto').randomBytes(Math.ceil(RunStore.MAX_SHARED_BYTES * 1.1)).toString('base64');
    await one.save({ id: 'big', status: 'complete', result: big });
    var read = await two.load('big');
    assert.equal(read.result, null);
    assert.equal(read.tooLargeToShare, true);
    await one.rememberFinal('u', { runId: 'r' });
    assert.deepEqual(await two.recentFinals('u'), [{ runId: 'r' }]);
    assert.equal(await one.claim('c', 5), true);
    assert.equal(await two.claim('c', 5), false, 'one at a time across processes');
    await one.release('c');
    assert.equal(await two.claim('c', 5), true);
    await two.release('c');
    await one.setJson('board:x', ['a']);
    assert.deepEqual(await two.getJson('board:x', []), ['a']);
    var heard = [];
    two.onStop(function(m) { heard.push(m); });
    await two.listening();
    assert.equal(await one.requestStop('move', 'm1', 'why', { a: 1 }), true);
    await until(function() { return heard.length > 0; });
    assert.deepEqual(heard, [{ kind: 'move', id: 'm1', message: 'why', extra: { a: 1 } }]);
  } finally {
    var c = one.client();
    for (var k of ['run:r', 'run:big', 'final:u', 'board:x']) await c.del(one.key(k)).catch(function() {});
    await one.close(); await two.close();
  }
});

test.after(async function() {
  try { await require('../lib/cache').getClient().quit(); } catch (e) { /* not opened */ }
});
