// totp: the codes an authenticator app shows (RFC 6238). RateLimiter as a
// lockout: only failures count, the max-th locks, a success forgets them.

var test = require('node:test');
var assert = require('node:assert');
var { totp, RateLimiter } = require('..');

test('totp: the codes RFC 6238 gives (its SHA-1 test vector), one step either side', function () {
  var secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(totp.codeAt(secret, 1), '287082');
  assert.ok(totp.verify(secret, '287082', 59000));
  assert.ok(totp.verify(secret, '287 082', 89000), 'one step late, and spaces, are taken');
  assert.ok(!totp.verify(secret, '287082', 200000), 'an old code is not');
  assert.ok(!totp.verify(secret, 'abc'));
  var fresh = totp.newSecret();
  assert.match(fresh, /^[A-Z2-7]{32}$/);
  assert.ok(totp.verify(fresh, totp.codeAt(fresh, Math.floor(Date.now() / 30000))));
  assert.equal(totp.otpauthUrl(fresh, 'ops@xeplr.com', 'Xeplr Monitor'),
    'otpauth://totp/Xeplr%20Monitor%3Aops%40xeplr.com?secret=' + fresh + '&issuer=Xeplr%20Monitor&algorithm=SHA1&digits=6&period=30');
});

test('RateLimiter as a lockout: max failures lock, a success forgets them', async function () {
  var tries = new RateLimiter({ windowInSeconds: 900, max: 3 });
  assert.equal(await tries.lockedFor('email:a'), 0);
  assert.deepEqual(await tries.fail('email:a'), { count: 1, lockedFor: 0 });
  await tries.fail('email:a');
  var third = await tries.fail('email:a');
  assert.equal(third.count, 3);
  assert.ok(third.lockedFor > 890 && third.lockedFor <= 900, String(third.lockedFor));
  assert.ok(await tries.lockedFor('email:a') > 890);
  assert.equal(await tries.lockedFor('email:b'), 0, 'another key is not locked');
  await tries.reset('email:a');
  assert.equal(await tries.lockedFor('email:a'), 0);
});

test('RateLimiter lockout: the window ends, the lock ends', async function () {
  var tries = new RateLimiter({ windowInSeconds: 1, max: 1 });
  await tries.fail('k');
  assert.ok(await tries.lockedFor('k') > 0);
  await new Promise(function (r) { setTimeout(r, 1100); });
  assert.equal(await tries.lockedFor('k'), 0);
});

test('RateLimiter lockout on Redis: the same, shared by every process', async function (t) {
  process.env.REDIS_PREFIX = process.env.REDIS_PREFIX || 'xeplr-utils-test-' + process.pid + ':';
  var cache = require('../lib/cache');
  var client;
  try { client = cache.getClient(); await client.ping(); } catch (err) { return t.skip('no Redis available: ' + err.message); }
  var key = 'lockout-test-' + process.pid;
  var tries = new RateLimiter({ windowInSeconds: 900, max: 2, store: 'redis' });
  try {
    assert.equal(await tries.lockedFor(key), 0);
    assert.equal((await tries.fail(key)).lockedFor, 0);
    assert.ok((await tries.fail(key)).lockedFor > 890);
    var other = new RateLimiter({ windowInSeconds: 900, max: 2, store: 'redis' });
    assert.ok(await other.lockedFor(key) > 890, 'another limiter (another process) sees the lock');
    await tries.reset(key);
    assert.equal(await other.lockedFor(key), 0);
  } finally {
    await tries.reset(key);
    await cache.disconnectCache();
  }
});
