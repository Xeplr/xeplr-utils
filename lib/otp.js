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
 *   await otp.requestOtp('+91...');              // generates + sends a code
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
 * Generate a code, store it, and send it via the configured SMS provider.
 * @param {string} identifier - phone number (or any unique key) the code is tied to
 * @returns {Promise<{ sent: boolean }>}
 */
async function requestOtp(identifier) {
  var code = generateCode();
  await cache.set(otpKey(identifier), { code: code, attempts: 0 }, _config.ttlSeconds);

  var message = _config.message(code);
  var result = _config.provider
    ? await sms.send(_config.provider, { to: identifier, message: message })
    : await sms.send({ to: identifier, message: message });

  if (!result.success) {
    await cache.del(otpKey(identifier));
    throw new Error('Failed to send OTP: ' + (result.error || 'unknown error'));
  }
  return { sent: true };
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

  if (String(code) !== record.code) {
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

module.exports = { configureOtp, requestOtp, verifyOtp };
