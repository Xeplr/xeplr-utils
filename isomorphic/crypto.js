/**
 * AES-256-GCM encrypt/decrypt — isomorphic (browser + Node).
 * Uses Web Crypto API (available in all modern browsers and Node 16+).
 * Zero dependencies.
 *
 * Usage:
 *   var { encrypt, decrypt } = require('@xeplr/utils/isomorphic/crypto');
 *
 *   var encrypted = await encrypt('hello world', 'my-secret-key');
 *   var decrypted = await decrypt(encrypted, 'my-secret-key');
 *   // decrypted === 'hello world'
 */

var subtle = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle
  ? globalThis.crypto.subtle
  : null;

function getSubtle() {
  if (subtle) return subtle;
  // Node fallback
  var nodeCrypto = require('crypto');
  return nodeCrypto.webcrypto.subtle;
}

function getRandomValues(buf) {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto.getRandomValues(buf);
  }
  var nodeCrypto = require('crypto');
  return nodeCrypto.webcrypto.getRandomValues(buf);
}

/**
 * Derive a 256-bit key from a passphrase using PBKDF2.
 */
async function deriveKey(passphrase, salt) {
  var s = getSubtle();
  var enc = new TextEncoder();
  var keyMaterial = await s.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(buf) {
  var bytes = new Uint8Array(buf);
  if (typeof btoa === 'function') {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(str) {
  if (typeof atob === 'function') {
    var binary = atob(str);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/**
 * Encrypt a string with a passphrase.
 * Returns a base64 string containing salt + iv + ciphertext.
 *
 * @param {string} plaintext - Text to encrypt
 * @param {string} key - Passphrase
 * @returns {Promise<string>} Base64-encoded encrypted payload
 */
async function encrypt(plaintext, key) {
  var salt = new Uint8Array(16);
  getRandomValues(salt);
  var iv = new Uint8Array(12);
  getRandomValues(iv);

  var cryptoKey = await deriveKey(key, salt);
  var enc = new TextEncoder();
  var ciphertext = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: iv },
    cryptoKey,
    enc.encode(plaintext)
  );

  // Pack: salt (16) + iv (12) + ciphertext
  var packed = new Uint8Array(16 + 12 + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, 16);
  packed.set(new Uint8Array(ciphertext), 28);

  return toBase64(packed);
}

/**
 * Decrypt a base64 payload with a passphrase.
 *
 * @param {string} encrypted - Base64-encoded encrypted payload from encrypt()
 * @param {string} key - Passphrase (must match the one used to encrypt)
 * @returns {Promise<string>} Decrypted plaintext
 */
async function decrypt(encrypted, key) {
  var packed = fromBase64(encrypted);
  var salt = packed.slice(0, 16);
  var iv = packed.slice(16, 28);
  var ciphertext = packed.slice(28);

  var cryptoKey = await deriveKey(key, salt);
  var decrypted = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: iv },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

module.exports = { encrypt, decrypt };
