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
      },
      get: async function(key) {
        var entry = hits[key];
        if (!entry || entry.expiresAt < Date.now()) return { count: 0, remaining: 0 };
        return { count: entry.count, remaining: Math.ceil((entry.expiresAt - Date.now()) / 1000) };
      },
      reset: async function(key) { delete hits[key]; }
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
      },
      get: async function(key) {
        var redisKey = 'xeplr:ratelimit:' + key;
        var count = Number(await client.get(redisKey)) || 0;
        var ttl = count ? await client.ttl(redisKey) : 0;
        return { count: count, remaining: ttl > 0 ? ttl : 0 };
      },
      reset: async function(key) { await client.del('xeplr:ratelimit:' + key); }
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

  // ── as a lockout: count only the failures ───────────────────────────────
  //
  // For sign-in, where a right password must never be counted against you:
  //
  //   var tries = new RateLimiter({ windowInSeconds: 900, max: 5 })
  //   var wait = await tries.lockedFor('email:' + email)   // seconds, 0 = go ahead
  //   if (wrong) await tries.fail('email:' + email)        // the max-th failure locks
  //   else await tries.reset('email:' + email)
  //
  // Fixed window from the first failure: `max` failures within it lock the key
  // until the window ends. Unlike middleware(), a broken store is NOT let
  // through here — these throw, and a sign-in that cannot count must refuse.

  /** Seconds until `key` may try again, or 0 when it has failed fewer than `max` times. */
  async lockedFor(key) {
    var r = await this._store.get(key);
    return r.count >= this._max ? Math.max(1, r.remaining) : 0;
  }

  /** Count one failure for `key`. → { count, lockedFor } (seconds; 0 while under max). */
  async fail(key) {
    var r = await this._store.increment(key);
    return { count: r.count, lockedFor: r.count >= this._max ? Math.max(1, r.remaining) : 0 };
  }

  /** Forget `key`'s failures, e.g. after a right password. */
  async reset(key) {
    await this._store.reset(key);
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
