// A SHARED BUDGET — "take this much of a total, wait your turn while it is not
// there, give it back after". Built for the memory of AutoML runs: each Python
// run takes the memory it may use, and the server never has more than the
// total given to all of them together. Generic: any amount of anything.
//
//   var budget = new SharedBudget({ name: 'ml-memory', total: 8192, store: 'redis' });
//   var lease = await budget.acquire(2048, { signal, onWait: (s) => log(...) });
//   try { ... } finally { await lease.release(); }
//
// FIRST COME, FIRST SERVED. Whoever asked first is next: a big request is
// never starved by a stream of small ones that would each have fitted.
//
// store 'redis' is shared by every process using the same Redis and prefix
// (several API workers, several servers): the take is one atomic Lua script,
// so two processes can never both take the last of it. store 'memory' is one
// process's own (tests, a single process).
//
// NOTHING IS HELD BY THE DEAD. A lease and a place in the queue expire unless
// renewed, and a live holder renews its own on a timer (unref'd). A process
// that crashes mid-run gives its share back within `leaseSeconds`.
//
// Asking for more than the whole total is refused at once (code
// BUDGET_TOO_LARGE) — it could never be given, and waiting for it would be
// waiting forever.

var crypto = require('crypto');

function refusal(message, code, extra) {
  return Object.assign(new Error(message), { code: code }, extra || {});
}

function stoppedError(signal) {
  var reason = signal && signal.reason;
  var err = new Error(reason && reason.message ? reason.message : 'Stopped while waiting');
  err.code = 'STOPPED';
  err.stopped = true;
  return err;
}

// ── the atomic step, in Redis ───────────────────────────────────────────────
// KEYS: 1 leases (hash id → amount), 2 lease expiries (zset id → ms),
//       3 queue (zset id → arrival), 4 queue expiries (zset id → ms)
// ARGV: 1 id, 2 amount, 3 total, 4 now ms, 5 expiry ms, 6 arrival
// Returns { taken (1|0), inUse, ahead } — ahead: how many are before this one.
var TRY_LUA = [
  "local now = tonumber(ARGV[4])",
  "for _, k in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)) do redis.call('HDEL', KEYS[1], k); redis.call('ZREM', KEYS[2], k) end",
  "for _, k in ipairs(redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)) do redis.call('ZREM', KEYS[3], k); redis.call('ZREM', KEYS[4], k) end",
  "if redis.call('ZSCORE', KEYS[3], ARGV[1]) == false then redis.call('ZADD', KEYS[3], ARGV[6], ARGV[1]) end",
  "redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])",
  "local used = 0",
  "for i, v in ipairs(redis.call('HVALS', KEYS[1])) do used = used + tonumber(v) end",
  "local ahead = redis.call('ZRANK', KEYS[3], ARGV[1])",
  "if ahead == 0 and used + tonumber(ARGV[2]) <= tonumber(ARGV[3]) then",
  "  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])",
  "  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])",
  "  redis.call('ZREM', KEYS[3], ARGV[1]); redis.call('ZREM', KEYS[4], ARGV[1])",
  "  return {1, used + tonumber(ARGV[2]), 0}",
  "end",
  "return {0, used, ahead}"
].join('\n');

function redisStore(name) {
  var client = require('./cache').getClient();
  var base = 'budget:' + name + ':';
  var keys = [base + 'leases', base + 'lease-exp', base + 'queue', base + 'queue-exp'];
  return {
    tryTake: async function(id, amount, total, expiresAt, arrival) {
      var r = await client.eval(TRY_LUA, 4, keys[0], keys[1], keys[2], keys[3],
        id, String(amount), String(total), String(Date.now()), String(expiresAt), String(arrival));
      return { taken: Number(r[0]) === 1, inUse: Number(r[1]), ahead: Number(r[2]) };
    },
    renewLease: async function(id, expiresAt) { await client.zadd(keys[1], 'XX', expiresAt, id); },
    release: async function(id) {
      await client.multi().hdel(keys[0], id).zrem(keys[1], id).exec();
    },
    leaveQueue: async function(id) {
      await client.multi().zrem(keys[2], id).zrem(keys[3], id).exec();
    },
    inUse: async function() {
      var vals = await client.hvals(keys[0]);
      return vals.reduce(function(s, v) { return s + Number(v); }, 0);
    }
  };
}

// One process's own, with the same rules (expiry included).
function memoryStore() {
  var leases = new Map();   // id → { amount, expiresAt }
  var queue = new Map();    // id → { arrival, expiresAt }
  function sweep(now) {
    leases.forEach(function(l, id) { if (l.expiresAt <= now) leases.delete(id); });
    queue.forEach(function(q, id) { if (q.expiresAt <= now) queue.delete(id); });
  }
  function used() {
    var s = 0;
    leases.forEach(function(l) { s += l.amount; });
    return s;
  }
  return {
    tryTake: async function(id, amount, total, expiresAt, arrival) {
      var now = Date.now();
      sweep(now);
      if (!queue.has(id)) queue.set(id, { arrival: arrival, expiresAt: expiresAt });
      queue.get(id).expiresAt = expiresAt;
      var order = Array.from(queue.entries()).sort(function(a, b) { return a[1].arrival - b[1].arrival; }).map(function(e) { return e[0]; });
      var ahead = order.indexOf(id);
      var inUse = used();
      if (ahead === 0 && inUse + amount <= total) {
        leases.set(id, { amount: amount, expiresAt: expiresAt });
        queue.delete(id);
        return { taken: true, inUse: inUse + amount, ahead: 0 };
      }
      return { taken: false, inUse: inUse, ahead: ahead };
    },
    renewLease: async function(id, expiresAt) { var l = leases.get(id); if (l) l.expiresAt = expiresAt; },
    release: async function(id) { leases.delete(id); },
    leaveQueue: async function(id) { queue.delete(id); },
    inUse: async function() { sweep(Date.now()); return used(); }
  };
}

/**
 * @param {object} opts
 * @param {string} opts.name           the budget's name (one total per name)
 * @param {number} opts.total          how much there is, in all
 * @param {'redis'|'memory'} [opts.store='memory']
 * @param {number} [opts.leaseSeconds=30]  a lease or a place in the queue not renewed for this long is let go
 * @param {number} [opts.pollMs=500]   how often a waiting request asks again
 */
class SharedBudget {
  constructor(opts) {
    var o = opts || {};
    if (!o.name) throw new Error('SharedBudget: name is required');
    if (!(Number(o.total) > 0)) throw new Error('SharedBudget: total must be a number above 0');
    this.name = o.name;
    this.total = Number(o.total);
    this.leaseMs = (Number(o.leaseSeconds) > 0 ? Number(o.leaseSeconds) : 30) * 1000;
    this.pollMs = Number(o.pollMs) > 0 ? Number(o.pollMs) : 500;
    this._store = o.store === 'redis' ? redisStore(o.name) : memoryStore();
  }

  /** How much is taken right now, by every holder. */
  inUse() { return this._store.inUse(); }

  /**
   * Take `amount`, waiting first-come-first-served until it is there.
   * `onWait({ amount, inUse, total, ahead })` is called once when it has to
   * wait, and again whenever how far back it is changes. `signal` stops the
   * wait (STOPPED). Resolves to a lease: `{ id, amount, release() }`.
   */
  async acquire(amount, opts) {
    var o = opts || {};
    var want = Number(amount);
    if (!(want > 0)) throw refusal('Ask for an amount above 0.', 'BUDGET_BAD_AMOUNT');
    if (want > this.total) {
      throw refusal('Needs ' + want + ', more than the whole ' + this.total + ' there is — it could never be given.',
        'BUDGET_TOO_LARGE', { amount: want, total: this.total });
    }
    var self = this;
    var store = this._store;
    var id = crypto.randomBytes(12).toString('hex');
    var arrival = Date.now() + Math.random() / 1000;
    var lastAhead = null;
    try {
      for (;;) {
        if (o.signal && o.signal.aborted) throw stoppedError(o.signal);
        var r = await store.tryTake(id, want, this.total, Date.now() + this.leaseMs, arrival);
        if (r.taken) break;
        if (o.onWait && r.ahead !== lastAhead) {
          lastAhead = r.ahead;
          o.onWait({ amount: want, inUse: r.inUse, total: this.total, ahead: r.ahead });
        }
        await waitOrStop(this.pollMs, o.signal);
      }
    } catch (err) {
      await store.leaveQueue(id).catch(function() {});
      throw err;
    }
    // Renewed while held, so only a dead process's lease runs out.
    var renew = setInterval(function() { store.renewLease(id, Date.now() + self.leaseMs).catch(function() {}); }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    if (renew.unref) renew.unref();
    var released = false;
    return {
      id: id,
      amount: want,
      release: async function() {
        if (released) return;
        released = true;
        clearInterval(renew);
        await store.release(id);
      }
    };
  }
}

function waitOrStop(ms, signal) {
  return new Promise(function(resolve, reject) {
    var t = setTimeout(done, ms);
    function done() { if (signal) signal.removeEventListener('abort', stop); resolve(); }
    function stop() { clearTimeout(t); reject(stoppedError(signal)); }
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

module.exports = SharedBudget;
