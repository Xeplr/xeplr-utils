// SharedBudget: take part of a total, wait first-come-first-served, give it back.
// The same rules in one process ('memory') and across processes ('redis' —
// two budgets of one name stand for two API workers). Redis tests skip, saying
// so, when no Redis answers.
var test = require('node:test');
var assert = require('node:assert/strict');
var SharedBudget = require('../lib/sharedBudget');

function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function name() { return 'test-' + process.pid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function redisUp() {
  process.env.REDIS_PREFIX = process.env.REDIS_PREFIX || ('xeplr-utils-test-' + process.pid + ':');
  try { await require('../lib/cache').getClient().ping(); return true; } catch (e) { return false; }
}

['memory', 'redis'].forEach(function(store) {
  test(store + ': takes what fits at once; the next waits until it is given back', async function(t) {
    if (store === 'redis' && !(await redisUp())) { t.skip('no Redis available'); return; }
    var b = new SharedBudget({ name: name(), total: 1000, store: store, pollMs: 20 });
    var a = await b.acquire(600);
    assert.equal(await b.inUse(), 600);
    var waited = [];
    var second = b.acquire(600, { onWait: function(s) { waited.push(s); } });
    await wait(80);
    assert.equal(waited.length >= 1 && waited[0].inUse, 600, 'told it is waiting, and how much is in use');
    assert.equal(waited[0].total, 1000);
    await a.release();
    var c = await second;
    assert.equal(await b.inUse(), 600);
    await c.release();
    assert.equal(await b.inUse(), 0);
  });

  test(store + ': first come, first served — a small request does not jump a big one', async function(t) {
    if (store === 'redis' && !(await redisUp())) { t.skip('no Redis available'); return; }
    var b = new SharedBudget({ name: name(), total: 1000, store: store, pollMs: 20 });
    var held = await b.acquire(700);
    var order = [];
    var big = b.acquire(800).then(function(l) { order.push('big'); return l; });
    await wait(40);
    var small = b.acquire(200).then(function(l) { order.push('small'); return l; });
    await wait(120);
    assert.deepEqual(order, [], 'the small one (it would fit) waits behind the big one');
    await held.release();
    var bigLease = await big;
    await wait(80);
    assert.deepEqual(order, ['big', 'small'].slice(0, order.length));
    await bigLease.release();
    var smallLease = await small;
    assert.deepEqual(order, ['big', 'small']);
    await smallLease.release();
  });

  test(store + ': more than the whole total is refused at once', async function(t) {
    if (store === 'redis' && !(await redisUp())) { t.skip('no Redis available'); return; }
    var b = new SharedBudget({ name: name(), total: 1000, store: store });
    await assert.rejects(b.acquire(1500), function(e) { return e.code === 'BUDGET_TOO_LARGE' && /more than the whole 1000/.test(e.message); });
    await assert.rejects(b.acquire(0), function(e) { return e.code === 'BUDGET_BAD_AMOUNT'; });
  });

  test(store + ': a stopped wait leaves the queue, and the next in line goes', async function(t) {
    if (store === 'redis' && !(await redisUp())) { t.skip('no Redis available'); return; }
    var b = new SharedBudget({ name: name(), total: 1000, store: store, pollMs: 20 });
    var held = await b.acquire(900);
    var stop = new AbortController();
    var first = b.acquire(500, { signal: stop.signal });
    await wait(40);
    var second = b.acquire(100);
    await wait(40);
    stop.abort(new Error('The run was stopped'));
    await assert.rejects(first, function(e) { return e.code === 'STOPPED' && /The run was stopped/.test(e.message); });
    var s = await second;   // it was behind the stopped one; it fits now
    assert.equal(await b.inUse(), 1000);
    await s.release(); await held.release();
  });

  test(store + ': what a dead holder took comes back by itself', async function(t) {
    if (store === 'redis' && !(await redisUp())) { t.skip('no Redis available'); return; }
    var n = name();
    var b = new SharedBudget({ name: n, total: 1000, store: store, leaseSeconds: 1, pollMs: 50 });
    // A holder that never renews nor releases: its lease written as a crashed process leaves it.
    await b._store.tryTake('dead-holder', 900, 1000, Date.now() + 300, 0);
    assert.equal(await b.inUse(), 900);
    var started = Date.now();
    var l = await b.acquire(500);
    assert.ok(Date.now() - started >= 200, 'it waited for the dead lease to run out');
    await l.release();
  });
});

test('redis: two budgets of one name (two processes) share one total', async function(t) {
  if (!(await redisUp())) { t.skip('no Redis available'); return; }
  var n = name();
  var workerA = new SharedBudget({ name: n, total: 1000, store: 'redis', pollMs: 20 });
  var workerB = new SharedBudget({ name: n, total: 1000, store: 'redis', pollMs: 20 });
  var a = await workerA.acquire(700);
  var gotB = false;
  var b = workerB.acquire(700).then(function(l) { gotB = true; return l; });
  await wait(120);
  assert.equal(gotB, false, 'the other process waits: 700 + 700 is over 1000');
  assert.equal(await workerB.inUse(), 700);
  await a.release();
  var lb = await b;
  assert.equal(gotB, true);
  await lb.release();
});

test.after(async function() {
  try { await require('../lib/cache').getClient().quit(); } catch (e) { /* none */ }
});
