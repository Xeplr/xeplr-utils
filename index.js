const { sendEmail, configureEmail, emailConfigFromEnv, smtpFromEnv, configureFromEnv } = require('./lib/email');
const { configureLogger, createSession, log, closeSession, getSessionLogs } = require('./lib/logger');
const { generateId, formatDbDateTime, mysqlDateTime } = require('./lib/helpers');
const { respond, sanitizeError } = require('./lib/response');
const cache = require('./lib/cache');
const Queue = require('./lib/queue');
// Which SQL failures are worth trying again — see lib/sql-error.js.
const { classifySqlError, isRetryableSqlError } = require('./lib/sql-error');
const FileUploader = require('./lib/fileUploader');
const RateLimiter = require('./lib/rateLimiter');
const sms = require('./lib/sms');
const otp = require('./lib/otp');

module.exports = {
  // Email
  sendEmail,
  configureEmail,
  emailConfigFromEnv,
  smtpFromEnv,
  configureFromEnv,

  // Logger client
  configureLogger,
  createSession,
  log,
  closeSession,
  getSessionLogs,

  // Helpers
  generateId,
  formatDbDateTime,
  mysqlDateTime, // alias for backward compat

  // Response helper
  respond,
  sanitizeError,

  // Cache (Redis)
  cache,

  // Queue
  Queue,

  // SQL error classification (retry decisions, and the code a log line carries)
  classifySqlError,
  isRetryableSqlError,

  // File Uploader
  FileUploader,

  // Rate Limiter
  RateLimiter,

  // SMS
  sms,

  // OTP (uses sms above for delivery)
  otp
};
