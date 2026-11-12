// TIME-BASED ONE-TIME CODES (RFC 6238) — the six digits an authenticator app
// shows. Node's crypto only; nothing to install, no Redis, no SMS: the code
// comes from a secret both sides hold and the time. 30-second steps, SHA-1,
// as every authenticator app expects; one step either side is accepted for a
// phone whose clock is a little off.
//
// Not `otp` (lib/otp.js): that one sends a code by SMS and keeps it in Redis.
//
//   var { totp } = require('@xeplr/utils')
//   var secret = totp.newSecret()                      // store it with the user
//   totp.otpauthUrl(secret, 'ops@xeplr.com', 'Xeplr Monitor')   // for the app (QR or paste)
//   totp.verify(secret, '287082')                      // true | false
var crypto = require('crypto');

var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new secret, base32 — what goes into the authenticator app. */
function newSecret() {
  return toBase32(crypto.randomBytes(20));
}

function toBase32(buf) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  var clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  var bits = 0, value = 0, bytes = [];
  for (var i = 0; i < clean.length; i++) {
    value = (value << 5) | ALPHABET.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** The code for one 30-second step. */
function codeAt(secret, step) {
  var counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step % 0x100000000, 4);
  var h = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  var o = h[h.length - 1] & 15;
  var n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

/** Whether a typed code is right now, or one step either side. */
function verify(secret, code, now) {
  var typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return false;
  var step = Math.floor((now || Date.now()) / 30000);
  for (var d = -1; d <= 1; d++) {
    var want = codeAt(secret, step + d);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(typed))) return true;
  }
  return false;
}

/** The link an authenticator app reads (as a QR code, or pasted). `issuer` is the name the app lists it under. */
function otpauthUrl(secret, account, issuer) {
  var by = issuer || 'Xeplr';
  var label = encodeURIComponent(by + ':' + account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(by) + '&algorithm=SHA1&digits=6&period=30';
}

module.exports = { newSecret: newSecret, verify: verify, codeAt: codeAt, otpauthUrl: otpauthUrl };
