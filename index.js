const { sendEmail, configureEmail, emailConfigFromEnv, configureFromEnv } = require('./lib/email');
const { configureLogger, createSession, log, closeSession, getSessionLogs } = require('./lib/logger');
const { generateId, formatDbDateTime, mysqlDateTime } = require('./lib/helpers');
const { respond, sanitizeError } = require('./lib/response');
const cache = require('./lib/cache');
const Queue = require('./lib/queue');
const FileUploader = require('./lib/fileUploader');
const RateLimiter = require('./lib/rateLimiter');
const sms = require('./lib/sms');
const otp = require('./lib/otp');

module.exports = {
  // Email
  sendEmail,
  configureEmail,
  emailConfigFromEnv,
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

  // File Uploader
  FileUploader,

  // Rate Limiter
  RateLimiter,

  // SMS
  sms,

  // OTP (uses sms above for delivery)
  otp
};
