/**
 * OTP (one-time password) — generate, deliver, and verify short-lived codes.
 * Delivery goes through THIS package's own sms module (see lib/sms.js: register
 * a provider there, then otp.js sends through it) — no separate provider
 * registration here, one registry to keep in sync.
 *
 * Codes live in Redis (lib/cache.js) — no DB table, no cleanup job. Expiry is
 * just the Redis key's TTL.
 *
 * Usage:
 *   var otp = require('@xeplr/utils').otp;
 *   otp.configureOtp({ provider: 'twilio' });   // optional — see defaults below
 *
 *   await otp.requestOtp('+91...');              // generates + sends a code by SMS
 *   await otp.requestOtp('login:' + userId, { send: function (code) { return mailIt(code) } })
 *   await otp.verifyOtp('+91...', '482913');     // { success: true } or { success:false, reason }
 */
const crypto = require('crypto');
const cache = require('./cache');
const sms = require('./sms');

var _config = {
  codeLength: 6,
  ttlSeconds: 300,     // 5 minutes
  maxAttempts: 5,
  keyPrefix: 'otp:',
  provider: null,       // sms provider name (see lib/sms.js register()); falls back to sms.setDefault()
  message: function(code) { return 'Your verification code is ' + code; }
};

/**
 * Configure OTP policy. All optional — defaults above apply otherwise.
 * @param {object} config
 * @param {number} [config.codeLength=6]
 * @param {number} [config.ttlSeconds=300]
 * @param {number} [config.maxAttempts=5]
 * @param {string} [config.provider] - sms provider name registered via sms.register()
 * @param {function} [config.message] - (code) => string, the SMS body
 */
function configureOtp(config) {
  Object.assign(_config, config || {});
}

function generateCode() {
  var max = Math.pow(10, _config.codeLength);
  var code = crypto.randomInt(0, max);
  return String(code).padStart(_config.codeLength, '0');
}

function otpKey(identifier) {
  return _config.keyPrefix + identifier;
}

/**
 * Generate a code, store it, and deliver it — by SMS through the configured
 * provider, or by whatever `options.send` does (an email, say). The code is
 * stored under `identifier` either way; delivery is the only thing that
 * changes, so an emailed code and a texted one expire, count wrong tries and
 * are used up exactly alike.
 *
 * @param {string} identifier - what the code is tied to: a phone number, or
 *   any unique key ('login:<userId>'). It is also the SMS recipient unless
 *   `options.to` names one.
 * @param {object} [options]
 * @param {string} [options.to] - the phone number to text, when `identifier`
 *   is a key rather than the number itself
 * @param {function} [options.send] - async (code) => void, delivers the code
 *   instead of SMS. A throw is a failed send: the code is forgotten and the
 *   error passed on.
 * @returns {Promise<{ sent: boolean }>}
 */
async function requestOtp(identifier, options) {
  var opts = options || {};
  var code = generateCode();
  await cache.set(otpKey(identifier), { code: code, attempts: 0 }, _config.ttlSeconds);

  if (typeof opts.send === 'function') {
    try {
      await opts.send(code);
    } catch (err) {
      await cache.del(otpKey(identifier));
      throw err;
    }
    return { sent: true };
  }

  var to = opts.to || identifier;
  var message = _config.message(code);
  var result = _config.provider
    ? await sms.send(_config.provider, { to: to, message: message })
    : await sms.send({ to: to, message: message });

  if (!result.success) {
    await cache.del(otpKey(identifier));
    throw new Error('Failed to send OTP: ' + (result.error || 'unknown error'));
  }
  return { sent: true };
}

/** Forget a code before it is used — e.g. when the thing it was for is cancelled. */
async function cancelOtp(identifier) {
  await cache.del(otpKey(identifier));
}

/**
 * Verify a submitted code against the stored one. Single-use — deleted on
 * success. maxAttempts is the real security bound (not TTL precision): a
 * wrong guess re-arms the same TTL window rather than tracking remaining
 * time, so repeated wrong guesses can extend the window, but never the
 * attempt count past maxAttempts.
 * @param {string} identifier
 * @param {string} code
 * @returns {Promise<{ success: boolean, reason?: 'expired'|'invalid'|'too_many_attempts' }>}
 */
async function verifyOtp(identifier, code) {
  var key = otpKey(identifier);
  var record = await cache.get(key);

  if (!record) {
    return { success: false, reason: 'expired' };
  }

  if (record.attempts >= _config.maxAttempts) {
    await cache.del(key);
    return { success: false, reason: 'too_many_attempts' };
  }

  if (String(code || '').replace(/\s/g, '') !== record.code) {
    record.attempts += 1;
    if (record.attempts >= _config.maxAttempts) {
      await cache.del(key);
      return { success: false, reason: 'too_many_attempts' };
    }
    await cache.set(key, record, _config.ttlSeconds);
    return { success: false, reason: 'invalid' };
  }

  await cache.del(key);
  return { success: true };
}

module.exports = { configureOtp, requestOtp, verifyOtp, cancelOtp };
