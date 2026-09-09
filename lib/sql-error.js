// WHICH SQL FAILURES ARE WORTH TRYING AGAIN.
//
// A retry is a bet that the same statement, sent again, behaves differently.
// That bet pays off for a dropped connection, a deadlock victim or a server
// out of connections — and never for a NOT NULL violation, a bad cast or a
// column that does not exist. Those fail identically every time, so retrying
// one costs the backoff (5s + 15s + 45s by default) and then drops the rows
// anyway.
//
// Measured on a real 1000-row movement into a NOT NULL column: 105 seconds,
// almost all of it asleep, for a verdict available on the first attempt. Worse
// than slow — a bisect restarts its children at attempt 0, so the wasted
// backoff multiplies down the bisect tree while a person watches a movement
// that looks hung.
//
// ── why one function serves postgres, mysql and mssql ────────────────────
//
// The three drivers throw their native error untouched (see each driver's
// query()), and each dialect stamps its identity on a DIFFERENT property:
//
//   postgres   err.code    5-char SQLSTATE — '23502', '40001'
//   mysql      err.code    ER_* name, plus err.errno — 'ER_BAD_NULL_ERROR', 1048
//   mssql      err.number  integer — 515, 1205
//
// So the shapes are self-identifying and no dbType has to be threaded through
// the queue to read them. A caller that HAS the dbType is not asked for it,
// which keeps this usable from the queue's default error executor — the one
// place that decides retries, and the one place with no idea what it is
// talking to.
//
// ── unknown means retry ─────────────────────────────────────────────────
//
// An unrecognised error is treated as transient, i.e. the behavior before this
// file existed. Wrongly retrying something deterministic costs time; wrongly
// dropping something transient loses rows. The default belongs on the side
// that cannot lose data.

// ── postgres ────────────────────────────────────────────────────────────
// SQLSTATE is classified by its two-character class where the whole class
// agrees, which is most of them — listing 200 individual codes would go stale
// against the next server release for no gain.
//
//   22  data exception            invalid text, numeric overflow, bad date
//   23  integrity constraint      not null, unique, foreign key, check
//   42  syntax error / access     no such column, no such table, no privilege
//   3F  invalid schema name
//   0A  feature not supported
var PG_DETERMINISTIC_CLASSES = ['22', '23', '42', '3F', '0A'];
//   08  connection exception      server closed the connection, failure
//   40  transaction rollback      serialization failure, deadlock detected
//   53  insufficient resources    too many connections, out of memory/disk
//   57  operator intervention     shutdown, cannot connect now, admin cancel
//   58  system error              io error
var PG_TRANSIENT_CLASSES = ['08', '40', '53', '57', '58'];

// ── mysql ───────────────────────────────────────────────────────────────
// By errno, because err.code (the ER_ name) is absent on some client
// versions while errno is always there. Names kept alongside for reading.
var MYSQL_DETERMINISTIC = {
  1048: 'ER_BAD_NULL_ERROR',          // column cannot be null
  1062: 'ER_DUP_ENTRY',               // duplicate key
  1064: 'ER_PARSE_ERROR',
  1136: 'ER_WRONG_VALUE_COUNT_ON_ROW',
  1146: 'ER_NO_SUCH_TABLE',
  1054: 'ER_BAD_FIELD_ERROR',         // unknown column
  1264: 'ER_WARN_DATA_OUT_OF_RANGE',
  1265: 'WARN_DATA_TRUNCATED',
  1292: 'ER_TRUNCATED_WRONG_VALUE',   // bad date / bad cast
  1366: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
  1406: 'ER_DATA_TOO_LONG',
  1451: 'ER_ROW_IS_REFERENCED_2',
  1452: 'ER_NO_REFERENCED_ROW_2',     // foreign key
  3819: 'ER_CHECK_CONSTRAINT_VIOLATED',
  1364: 'ER_NO_DEFAULT_FOR_FIELD',
  1305: 'ER_SP_DOES_NOT_EXIST'
};
var MYSQL_TRANSIENT = {
  1040: 'ER_CON_COUNT_ERROR',         // too many connections
  1203: 'ER_TOO_MANY_USER_CONNECTIONS',
  1205: 'ER_LOCK_WAIT_TIMEOUT',
  1213: 'ER_LOCK_DEADLOCK',
  1290: 'ER_OPTION_PREVENTS_STATEMENT', // read-only, usually a failover
  1053: 'ER_SERVER_SHUTDOWN',
  2002: 'CONNECTION_REFUSED',
  2003: 'CANT_CONNECT',
  2006: 'SERVER_GONE_AWAY',
  2013: 'LOST_CONNECTION'
};
// Client-side codes carry no errno at all — a socket that died before the
// server ever answered.
var MYSQL_TRANSIENT_CODES = [
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'POOL_CLOSED', 'POOL_CONNLIMIT'
];

// ── mssql ───────────────────────────────────────────────────────────────
var MSSQL_DETERMINISTIC = {
  515:  'cannot insert NULL',
  547:  'foreign key / check constraint',
  2601: 'duplicate key in unique index',
  2627: 'unique constraint violation',
  245:  'conversion failed',
  8114: 'error converting data type',
  8152: 'string or binary data would be truncated',
  2628: 'string or binary data would be truncated (verbose)',
  207:  'invalid column name',
  208:  'invalid object name',
  102:  'incorrect syntax',
  220:  'arithmetic overflow',
  232:  'arithmetic overflow for type',
  8115: 'arithmetic overflow converting'
};
var MSSQL_TRANSIENT = {
  1205:  'deadlock victim',
  1222:  'lock request timeout',
  3960:  'snapshot isolation update conflict',
  4060:  'cannot open database',
  40197: 'azure: service error, request processing',
  40501: 'azure: service busy',
  40613: 'azure: database unavailable',
  49918: 'azure: cannot process request, not enough resources',
  49919: 'azure: cannot process create or update request',
  49920: 'azure: cannot process request, too many operations',
  10053: 'transport-level error',
  10054: 'connection reset by peer',
  10060: 'connection timeout',
  233:   'no process on the other end of the pipe',
  64:    'transport-level error on receive'
};

// Node's own socket-level failures, dialect-independent: the driver never got
// far enough for the server to have an opinion.
var NODE_TRANSIENT_CODES = [
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ESOCKETTIMEOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNCLOSED', 'ETIMEOUT', 'ENOTOPEN'
];

/**
 * Classify one database error.
 *
 * @returns {{ retryable: boolean, kind: string, code: string|null, dialect: string|null }}
 *   kind is 'transient' | 'deterministic' | 'unknown'. `code` is whatever the
 *   dialect stamped on it, as a string, so a log line can carry the database's
 *   own identifier rather than a paraphrase of it.
 */
function classifySqlError(err) {
  var unknown = { retryable: true, kind: 'unknown', code: null, dialect: null };
  if (!err) return unknown;

  var code = err.code != null ? String(err.code) : null;

  // Socket-level, before any dialect has spoken.
  if (code && NODE_TRANSIENT_CODES.indexOf(code) !== -1) {
    return { retryable: true, kind: 'transient', code: code, dialect: null };
  }

  // postgres — SQLSTATE: exactly five characters, digits and capitals.
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    var cls = code.slice(0, 2);
    if (PG_DETERMINISTIC_CLASSES.indexOf(cls) !== -1) {
      return { retryable: false, kind: 'deterministic', code: code, dialect: 'postgres' };
    }
    if (PG_TRANSIENT_CLASSES.indexOf(cls) !== -1) {
      return { retryable: true, kind: 'transient', code: code, dialect: 'postgres' };
    }
    return { retryable: true, kind: 'unknown', code: code, dialect: 'postgres' };
  }

  // mysql — errno is the reliable half; the ER_ name is not always present.
  var errno = typeof err.errno === 'number' ? err.errno : null;
  if (errno != null && (MYSQL_DETERMINISTIC[errno] || MYSQL_TRANSIENT[errno])) {
    var mysqlCode = code || MYSQL_DETERMINISTIC[errno] || MYSQL_TRANSIENT[errno];
    return MYSQL_DETERMINISTIC[errno]
      ? { retryable: false, kind: 'deterministic', code: mysqlCode, dialect: 'mysql' }
      : { retryable: true,  kind: 'transient',     code: mysqlCode, dialect: 'mysql' };
  }
  if (code && MYSQL_TRANSIENT_CODES.indexOf(code) !== -1) {
    return { retryable: true, kind: 'transient', code: code, dialect: 'mysql' };
  }
  // An ER_-named error with an errno this file has never heard of is still
  // mysql, and still unknown — reported as such rather than guessed at.
  if (code && /^ER_/.test(code)) {
    return { retryable: true, kind: 'unknown', code: code, dialect: 'mysql' };
  }

  // mssql — tedious puts the server's error number on `number`.
  var number = typeof err.number === 'number' ? err.number : null;
  if (number != null) {
    if (MSSQL_DETERMINISTIC[number]) {
      return { retryable: false, kind: 'deterministic', code: String(number), dialect: 'mssql' };
    }
    if (MSSQL_TRANSIENT[number]) {
      return { retryable: true, kind: 'transient', code: String(number), dialect: 'mssql' };
    }
    return { retryable: true, kind: 'unknown', code: String(number), dialect: 'mssql' };
  }

  return code ? { retryable: true, kind: 'unknown', code: code, dialect: null } : unknown;
}

/** True only when trying the identical statement again could plausibly work. */
function isRetryableSqlError(err) { return classifySqlError(err).retryable; }

module.exports = {
  classifySqlError: classifySqlError,
  isRetryableSqlError: isRetryableSqlError
};
