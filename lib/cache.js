const Redis = require('ioredis');

let _client = null;
let _config = {};

/**
 * Configure the Redis cache.
 * @param {object} config
 * @param {string} [config.host='127.0.0.1']
 * @param {number} [config.port=6379]
 * @param {string} [config.password]
 * @param {number} [config.db=0]
 * @param {string} [config.keyPrefix='xeplr:']
 * @param {number} [config.defaultTTL=300] - Default TTL in seconds (5 min)
 * @param {number} [config.maxRetriesPerRequest=3]
 * @param {boolean} [config.enableOfflineQueue=true]
 * @param {boolean} [config.lazyConnect=true] - Don't connect until first use
 */
function configureCache(config = {}) {
  _config = {
    host: config.host || process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(config.port || process.env.REDIS_PORT || '6379'),
    password: config.password || process.env.REDIS_PASSWORD || undefined,
    db: config.db || parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: config.keyPrefix || process.env.REDIS_PREFIX || 'xeplr:',
    defaultTTL: config.defaultTTL || 300,
    maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
    enableOfflineQueue: config.enableOfflineQueue !== false,
    lazyConnect: config.lazyConnect !== false
  };

  // Disconnect existing client if reconfiguring
  if (_client) {
    _client.disconnect();
    _client = null;
  }
}

function getClient() {
  if (_client) return _client;

  const opts = {
    host: _config.host || process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(_config.port || process.env.REDIS_PORT || '6379'),
    password: _config.password || process.env.REDIS_PASSWORD || undefined,
    db: _config.db || parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: _config.keyPrefix || process.env.REDIS_PREFIX || 'xeplr:',
    lazyConnect: _config.lazyConnect !== false,

    // Performance: limit retries so requests don't pile up
    maxRetriesPerRequest: _config.maxRetriesPerRequest || 3,

    // Keep offline queue so commands are buffered during brief disconnects
    enableOfflineQueue: _config.enableOfflineQueue !== false,

    // Reconnect with exponential backoff, cap at 3s
    retryStrategy(times) {
      if (times > 10) return null; // stop reconnecting after 10 attempts
      return Math.min(times * 200, 3000);
    },

    // Connection pool: ioredis uses a single connection with pipelining,
    // which handles high concurrency better than connection pools for most cases.
    // For extreme throughput, use Cluster mode instead.
  };

  _client = new Redis(opts);

  _client.on('error', (err) => {
    // Silently handle — don't crash the server if Redis is down
    // The get/set methods below fall through gracefully
  });

  if (opts.lazyConnect) {
    _client.connect().catch(() => {});
  }

  return _client;
}

/**
 * Get a cached value.
 * Returns null if not found or Redis is unavailable.
 */
async function get(key) {
  try {
    const client = getClient();
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null; // Cache miss on error — fall through to DB
  }
}

/**
 * Set a cached value with TTL.
 * @param {string} key
 * @param {any} value - Will be JSON.stringify'd
 * @param {number} [ttl] - TTL in seconds (default: configured defaultTTL)
 */
async function set(key, value, ttl) {
  try {
    const client = getClient();
    const seconds = ttl || _config.defaultTTL || 300;
    await client.set(key, JSON.stringify(value), 'EX', seconds);
  } catch (e) {
    // Silently fail — cache is non-critical
  }
}

/**
 * Delete a specific key.
 */
async function del(key) {
  try {
    const client = getClient();
    await client.del(key);
  } catch (e) {
    // Silently fail
  }
}

/**
 * Delete all keys matching a pattern.
 * Uses SCAN to avoid blocking Redis on large keyspaces.
 * @param {string} pattern - e.g. 'access:user:*'
 */
async function delPattern(pattern) {
  try {
    const client = getClient();
    const prefix = _config.keyPrefix || '';
    let cursor = '0';
    do {
      // SCAN with the full prefixed pattern
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', prefix + pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        // Strip prefix since ioredis adds it automatically
        const stripped = keys.map(k => k.startsWith(prefix) ? k.slice(prefix.length) : k);
        await client.del(...stripped);
      }
    } while (cursor !== '0');
  } catch (e) {
    // Silently fail
  }
}

/**
 * Disconnect Redis client (for graceful shutdown).
 */
async function disconnectCache() {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

module.exports = {
  configureCache,
  get,
  set,
  del,
  delPattern,
  disconnectCache,
  getClient
};
