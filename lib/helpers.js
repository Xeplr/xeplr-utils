const crypto = require('crypto');

/**
 * Generate a random ID string (25 chars hex).
 */
function generateId() {
  return crypto.randomBytes(12).toString('hex').substring(0, 25);
}

/**
 * Format a Date as ISO datetime string for database storage.
 */
function formatDbDateTime(date) {
  return (date || new Date()).toISOString();
}

// Keep alias for backward compat
module.exports = { generateId, formatDbDateTime, mysqlDateTime: formatDbDateTime };
