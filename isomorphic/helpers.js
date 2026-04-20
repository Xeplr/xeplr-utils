/**
 * Pure JS helpers — safe for both browser and Node.
 * No Node-specific APIs (crypto, fs, etc.).
 */

/**
 * Format a Date as ISO datetime string for database storage.
 */
function formatDbDateTime(date) {
  return (date || new Date()).toISOString();
}

/**
 * Format a Date for display (e.g. "15 Mar 2026").
 */
function formatDate(date, locale = 'en-GB') {
  return (date || new Date()).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

/**
 * Format a Date for display with time (e.g. "15 Mar 2026, 14:30").
 */
function formatDateTime(date, locale = 'en-GB') {
  return (date || new Date()).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Simple deep-clone using structured clone (works in modern browsers + Node 17+).
 * Falls back to JSON parse/stringify.
 */
function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if a value is empty (null, undefined, '', [], {}).
 */
function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

module.exports = { formatDbDateTime, mysqlDateTime: formatDbDateTime, formatDate, formatDateTime, deepClone, isEmpty };
