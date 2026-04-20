/**
 * Email normalizer — strips dots and plus-aliases for known providers.
 * Prevents vikas.bhandari@gmail.com and vikasbhandari@gmail.com from being different users.
 *
 * Known dot-insensitive providers:
 *   Gmail, Google Workspace, Googlemail
 *
 * Also strips +alias for these providers:
 *   vikas+test@gmail.com → vikas@gmail.com
 */

var DOT_INSENSITIVE_DOMAINS = [
  'gmail.com',
  'googlemail.com'
];

/**
 * Normalize an email for duplicate detection.
 * Returns lowercase, dot-stripped (for known providers), plus-alias stripped.
 *
 * @param {string} email
 * @returns {string} Normalized email
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';

  var parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return email.trim().toLowerCase();

  var local = parts[0];
  var domain = parts[1];

  // Strip +alias for known providers
  if (isDotInsensitive(domain)) {
    var plusIndex = local.indexOf('+');
    if (plusIndex > 0) {
      local = local.slice(0, plusIndex);
    }
    // Strip dots
    local = local.replace(/\./g, '');
  }

  return local + '@' + domain;
}

/**
 * Check if a domain ignores dots in the local part.
 */
function isDotInsensitive(domain) {
  for (var i = 0; i < DOT_INSENSITIVE_DOMAINS.length; i++) {
    if (domain === DOT_INSENSITIVE_DOMAINS[i]) return true;
  }
  return false;
}

module.exports = { normalizeEmail, isDotInsensitive };
