// otp: a code delivered your way (send) is stored, expires and counts wrong
// tries exactly as a texted one; a failed send forgets it. Real Redis.

var test = require('node:test');
var assert = require('node:assert');

process.env.REDIS_PREFIX = process.env.REDIS_PREFIX || 'xeplr-utils-test-' + process.pid + ':';
var cache = require('../lib/cache');
var { otp } = require('..');

async function redisOrSkip(t) {
  try { await cache.getClient().ping(); return true; } catch (err) { t.skip('no Redis available: ' + err.message); return false; }
}

test('otp send: delivered by the function, verified once, spaces ignored', async function (t) {
  if (!(await redisOrSkip(t))) return;
  var key = 'test:login:' + process.pid;
  var got = null;
  var r = await otp.requestOtp(key, { send: async function (code) { got = code; } });
  assert.deepEqual(r, { sent: true });
  assert.match(got, /^\d{6}$/);
  assert.equal((await otp.verifyOtp(key, '000000' === got ? '111111' : '000000')).reason, 'invalid');
  var spaced = got.slice(0, 3) + ' ' + got.slice(3);
  assert.deepEqual(await otp.verifyOtp(key, spaced), { success: true });
  assert.equal((await otp.verifyOtp(key, got)).reason, 'expired', 'used up');
});

test('otp send: a failed send forgets the code and passes the error on', async function (t) {
  if (!(await redisOrSkip(t))) return;
  var key = 'test:fail:' + process.pid;
  await assert.rejects(otp.requestOtp(key, { send: async function () { throw new Error('mail down'); } }), /mail down/);
  assert.equal((await otp.verifyOtp(key, '123456')).reason, 'expired');
});

test('otp cancelOtp: the code is gone', async function (t) {
  if (!(await redisOrSkip(t))) return;
  var key = 'test:cancel:' + process.pid;
  var got = null;
  await otp.requestOtp(key, { send: async function (code) { got = code; } });
  await otp.cancelOtp(key);
  assert.equal((await otp.verifyOtp(key, got)).reason, 'expired');
});

test.after(async function () { try { await cache.disconnectCache(); } catch (e) {} });
