/**
 * xeplr-utils/isomorphic — runs everywhere (browser + Node).
 * Zero Node-specific dependencies.
 *
 * Usage:
 *   // Backend (CJS)
 *   const { HTTP, STATUS, MESSAGES, msg } = require('@xeplr/utils/isomorphic');
 *
 *   // UI (ESM via Vite)
 *   import { HTTP, STATUS, MESSAGES, msg } from 'xeplr-utils/isomorphic';
 */

const { HTTP, STATUS } = require('./codes');
const { MESSAGES } = require('./messages');
const { readResponse } = require('./responseReader');
const helpers = require('./helpers');
const { encrypt, decrypt } = require('./crypto');
const { normalizeEmail, isDotInsensitive } = require('./emailNormalizer');
const { COUNTRIES } = require('./countries');
const { STATES, STATES_IN } = require('./states');

// --- Language resolution ---

let _lang = null;

/**
 * Set the active language explicitly.
 *   configureLang('fr');
 */
function configureLang(lang) {
  _lang = lang;
}

/**
 * Get current language.
 * Priority: configureLang() > APP_LANG env var > 'en'
 */
function getLang() {
  if (_lang) return _lang;

  if (typeof process !== 'undefined' && process.env && process.env.APP_LANG) {
    return process.env.APP_LANG;
  }

  if (typeof window !== 'undefined' && window.__APP_LANG__) {
    return window.__APP_LANG__;
  }

  return 'en';
}

/**
 * Get the i18n message string for a message key.
 *   msg('success')        → 'Success'
 *   msg('success', 'fr')  → 'Succès'
 */
function msg(messageKey, lang) {
  const l = lang || getLang();
  const m = MESSAGES[messageKey];
  if (!m) return messageKey;
  return m[l] || m.en;
}

module.exports = {
  // Language
  configureLang,
  getLang,
  msg,

  // Constants
  HTTP,
  STATUS,
  MESSAGES,

  // Response reader
  readResponse,

  // Helpers
  ...helpers,

  // Crypto
  encrypt,
  decrypt,

  // Email normalization
  normalizeEmail,
  isDotInsensitive,

  // Static lookups
  COUNTRIES,
  STATES,
  STATES_IN
};
