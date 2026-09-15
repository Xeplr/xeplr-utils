// delPattern must delete under the prefix the client writes with — including
// when that prefix comes from REDIS_PREFIX rather than configureCache().
var test = require('node:test');
var assert = require('node:assert/strict');

var skip = null;

test('delPattern deletes keys written under REDIS_PREFIX', async function(t) {
  process.env.REDIS_PREFIX = 'xeplr-utils-test-' + process.pid + ':';
  var cache = require('../lib/cache');
  try {
    await cache.set('access:user:1', { a: 1 }, 60);
  } catch (err) {
    skip = err.message;
  }
  if (skip || !(await cache.get('access:user:1'))) { t.skip('no Redis available'); return; }
  try {
    await cache.set('access:user:2', { a: 2 }, 60);
    await cache.set('access:api:x', { b: 1 }, 60);

    await cache.delPattern('access:user:*');

    assert.equal(await cache.get('access:user:1'), null);
    assert.equal(await cache.get('access:user:2'), null);
    assert.deepEqual(await cache.get('access:api:x'), { b: 1 }, 'other keys are left alone');
    await cache.delPattern('access:*');
    assert.equal(await cache.get('access:api:x'), null);
  } finally {
    // Always — an open Redis connection keeps the test process alive.
    await cache.delPattern('access:*');
    await cache.disconnectCache();
  }
});
