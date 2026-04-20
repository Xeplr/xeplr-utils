var MemoryStore = {
  create: function() {
    var items = [];
    return {
      push: function(item) { items.push(item); },
      shift: async function() { return items.shift(); },
      length: async function() { return items.length; },
      list: async function() { return items.slice(); },
      clear: async function() { items.length = 0; }
    };
  }
};

var RedisStore = {
  create: function(options) {
    var cache = require('./cache');
    var client = cache.getClient();
    var key = options.redisKey || 'xeplr:queue:default';

    return {
      push: function(item) {
        client.rpush(key, JSON.stringify(item));
      },
      shift: async function() {
        var raw = await client.lpop(key);
        return raw ? JSON.parse(raw) : undefined;
      },
      length: async function() {
        return await client.llen(key);
      },
      list: async function() {
        var rawItems = await client.lrange(key, 0, -1);
        return rawItems.map(function(raw) { return JSON.parse(raw); });
      },
      clear: async function() {
        await client.del(key);
      }
    };
  }
};

class Queue {
  constructor(options = {}) {
    this.action = options.action || null;
    this.autoIntervalInSeconds = options.autoIntervalInSeconds || 0;
    this.maxEmptyTicks = options.maxEmptyTicks || 0;
    this._processing = false;
    this._paused = false;
    this._stopped = false;
    this._emptyTicks = 0;

    var storeType = options.store || 'memory';
    if (storeType === 'redis') {
      this._store = RedisStore.create(options);
    } else {
      this._store = MemoryStore.create();
    }

    if (this.autoIntervalInSeconds > 0) {
      this._scheduleNext();
    }
  }

  addToQueue(item) {
    this._store.push(item);
    if (this._paused && !this._stopped) {
      this.resume();
    }
  }

  async flushQueue() {
    if (this._processing || this._paused) return;
    var len = await this._store.length();
    if (len === 0) return;
    this._processing = true;
    try {
      while (true) {
        if (this._paused) break;
        var item = await this._store.shift();
        if (item === undefined) break;
        if (this.action) {
          await this.action(item);
        }
      }
    } finally {
      this._processing = false;
    }
  }

  pause() {
    this._paused = true;
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._emptyTicks = 0;
    if (this.autoIntervalInSeconds > 0 && !this._stopped) {
      this._scheduleNext();
    }
  }

  stop() {
    this._stopped = true;
    this._paused = true;
  }

  /**
   * List all items in the queue without removing them.
   */
  async list() {
    return this._store.list();
  }

  /**
   * Clear all items from the queue.
   */
  async clear() {
    return this._store.clear();
  }

  /**
   * Drain all items from the queue and return them.
   * Items are removed from the queue.
   */
  async drain() {
    var result = [];
    while (true) {
      var item = await this._store.shift();
      if (item === undefined) break;
      result.push(item);
    }
    return result;
  }

  _scheduleNext() {
    if (this._stopped || this._paused) return;
    var self = this;
    var timer = setTimeout(async function() {
      var len = await self._store.length();
      if (len === 0) {
        self._emptyTicks++;
        if (self.maxEmptyTicks > 0 && self._emptyTicks >= self.maxEmptyTicks) {
          self._paused = true;
          return;
        }
      } else {
        self._emptyTicks = 0;
        await self.flushQueue();
      }
      self._scheduleNext();
    }, self.autoIntervalInSeconds * 1000);

    if (timer && timer.unref) {
      timer.unref();
    }
  }
}

module.exports = Queue;
