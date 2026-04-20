/**
 * Response helper — sends a fixed-format JSON response.
 *
 * Format:
 *   {
 *     code:       'SUC_LOGIN' | 'ERR_INVALID_FILE' | STATUS.SUCCESS | ...,
 *     message:    'Human-readable message (i18n aware)',
 *     error:      null | { name, message, ...details },
 *     dataArray:  [],
 *     updatedIds: []
 *   }
 *
 * Usage:
 *   const { respond } = require('@xeplr/utils');
 *   const { HTTP, STATUS } = require('@xeplr/utils/isomorphic');
 *
 *   // Success
 *   respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: orders });
 *
 *   // Error
 *   respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', { error: err });
 *
 *   // With updatedIds
 *   respond(res, HTTP.OK, STATUS.UPDATED, 'updated', { updatedIds: [1, 2, 3] });
 *
 *   // Minimal
 *   respond(res, HTTP.OK, STATUS.SUCCESS, 'success');
 */

const { msg } = require('../isomorphic');

/**
 * Sanitize an error object for serialization (strips stack trace).
 */
function sanitizeError(err) {
  if (!err) return null;

  const clean = {
    name: err.name || 'Error',
    message: err.message || String(err),
  };

  // Preserve any extra properties (e.g. err.code, err.field, err.details)
  // but skip stack, __proto__, constructor
  const skip = new Set(['name', 'message', 'stack']);
  for (const key of Object.keys(err)) {
    if (!skip.has(key)) {
      clean[key] = err[key];
    }
  }

  return clean;
}

/**
 * Send a standardized response.
 *
 * @param {object} res         - Express response object
 * @param {number} httpCode    - HTTP status code (from HTTP constants)
 * @param {string} statusCode  - Application status code (from STATUS constants)
 * @param {string} messageKey  - Key in MESSAGES for i18n lookup
 * @param {object} [options]   - Optional overrides
 * @param {Array}  [options.dataArray]   - Response data (default: [])
 * @param {Array}  [options.updatedIds]  - IDs affected by the operation (default: [])
 * @param {Error}  [options.error]       - Error object, sanitized before sending (default: null)
 * @param {string} [options.message]     - Override the i18n message with a custom string
 * @param {object} [options.pagination]  - { page, limit, total, totalPages }
 */
function respond(res, httpCode, statusCode, messageKey, options = {}) {
  const body = {
    code:       statusCode,
    message:    options.message || msg(messageKey),
    error:      sanitizeError(options.error),
    dataArray:  options.dataArray || [],
    updatedIds: options.updatedIds || [],
    sessionId:  res.req && res.req.sessionId || null,
  };

  if (options.pagination) {
    body.pagination = options.pagination;
  }

  return res.status(httpCode).send(body);
}

module.exports = { respond, sanitizeError };
