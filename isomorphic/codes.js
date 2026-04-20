/**
 * Standalone constants — no dependencies on other files.
 * Add any shared constants here (codes, enums, limits, etc.)
 */

// ── HTTP Status Codes ──
const HTTP = {
  OK:                  200,
  CREATED:             201,
  BAD_REQUEST:         400,
  UNAUTHORIZED:        401,
  FORBIDDEN:           403,
  NOT_FOUND:           404,
  CONFLICT:            409,
  VALIDATION_ERROR:    422,
  TOO_MANY_REQUESTS:   429,
  SERVER_ERROR:        500,
  SERVICE_UNAVAILABLE: 503,
};

// ── Application Status Codes (business logic, machine-readable) ──
const STATUS = {
  // Generic
  SUCCESS:                'SUCCESS',
  CREATED:                'CREATED',
  UPDATED:                'UPDATED',
  DELETED:                'DELETED',
  BAD_REQUEST:            'BAD_REQUEST',
  UNAUTHORIZED:           'UNAUTHORIZED',
  FORBIDDEN:              'FORBIDDEN',
  NOT_FOUND:              'NOT_FOUND',
  CONFLICT:               'CONFLICT',
  VALIDATION_ERROR:       'VALIDATION_ERROR',
  TOO_MANY_REQUESTS:      'TOO_MANY_REQUESTS',
  SERVER_ERROR:           'SERVER_ERROR',
  SERVICE_UNAVAILABLE:    'SERVICE_UNAVAILABLE',

  // Auth
  LOGIN_SUCCESS:          'LOGIN_SUCCESS',
  LOGIN_FAILED:           'LOGIN_FAILED',
  LOGOUT_SUCCESS:         'LOGOUT_SUCCESS',
  ACCOUNT_NOT_ACTIVE:     'ACCOUNT_NOT_ACTIVE',
  PASSWORD_RESET_SENT:    'PASSWORD_RESET_SENT',
  PASSWORD_RESET_SUCCESS: 'PASSWORD_RESET_SUCCESS',
  INVALID_TOKEN:          'INVALID_TOKEN',

  // App-specific (add your own)
  // ERR_INVALID_IMPORT_FILE: 'ERR_INVALID_IMPORT_FILE',
};

module.exports = { HTTP, STATUS };
