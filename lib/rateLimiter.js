var MemoryStore = {
  create: function(windowInSeconds) {
    var hits = {};

    // cleanup expired keys periodically
    var cleanup = setInterval(function() {
      var now = Date.now();
      for (var key in hits) {
        if (hits[key].expiresAt < now) {
          delete hits[key];
        }
      }
    }, windowInSeconds * 1000);

    if (cleanup && cleanup.unref) cleanup.unref();

    return {
      increment: async function(key) {
        var now = Date.now();
        var entry = hits[key];
        if (!entry || entry.expiresAt < now) {
          hits[key] = { count: 1, expiresAt: now + windowInSeconds * 1000 };
          return { count: 1, remaining: windowInSeconds };
        }
        entry.count++;
        var remaining = Math.ceil((entry.expiresAt - now) / 1000);
        return { count: entry.count, remaining: remaining };
      }
    };
  }
};

var RedisStore = {
  create: function(windowInSeconds) {
    var cache = require('./cache');
    var client = cache.getClient();

    return {
      increment: async function(key) {
        var redisKey = 'xeplr:ratelimit:' + key;
        var count = await client.incr(redisKey);
        if (count === 1) {
          await client.expire(redisKey, windowInSeconds);
        }
        var ttl = await client.ttl(redisKey);
        return { count: count, remaining: ttl > 0 ? ttl : windowInSeconds };
      }
    };
  }
};

class RateLimiter {
  /**
   * @param {object} options
   * @param {number} [options.windowInSeconds=60] - Time window in seconds
   * @param {number} [options.max=100] - Max requests per window
   * @param {string} [options.store='memory'] - 'memory' or 'redis'
   * @param {function} [options.keyFn] - Function to extract key from req (default: req.ip)
   * @param {string} [options.message] - Custom error message
   */
  constructor(options = {}) {
    this._windowInSeconds = options.windowInSeconds || 60;
    this._max = options.max || 100;
    this._keyFn = options.keyFn || function(req) { return req.ip; };
    this._message = options.message || 'Too many requests, please try again later';

    var storeType = options.store || 'memory';
    if (storeType === 'redis') {
      this._store = RedisStore.create(this._windowInSeconds);
    } else {
      this._store = MemoryStore.create(this._windowInSeconds);
    }
  }

  middleware() {
    var self = this;
    return async function(req, res, next) {
      try {
        var key = self._keyFn(req);
        var result = await self._store.increment(key);

        res.setHeader('X-RateLimit-Limit', self._max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, self._max - result.count));
        res.setHeader('X-RateLimit-Reset', result.remaining);

        if (result.count > self._max) {
          res.setHeader('Retry-After', result.remaining);
          return res.status(429).json({ error: self._message });
        }

        next();
      } catch (err) {
        // if rate limiter fails, let the request through
        next();
      }
    };
  }
}

module.exports = RateLimiter;
