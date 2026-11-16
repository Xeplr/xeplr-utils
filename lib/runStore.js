// RUNS, SHARED ACROSS PROCESSES — the store.
//
// Long work (an import, a report query, an export) is started by one process
// and does its work there. Everything asked about it afterwards — how far it
// has got, its result, ✕ — may land on ANY process once an app runs several
// (Node's cluster, several servers behind one address). So what a run says
// about itself is kept here, and the work's stop switch is reachable from any
// process.
//
//   var store = new RunStore({ store: 'redis' })          // or RunStore.fromEnv()
//   await store.save({ id, userId, status, progress }, store.RUNNING_SECONDS)
//   await store.load(id)                                  // from any process
//   store.onStop(function(msg) { ...abort msg.id if it is mine... })
//   await store.requestStop('import', id, 'Stopped')      // heard by every process
//
// store: 'redis'   shared by every process using the same Redis and prefix.
//                  The client is @xeplr/utils' own (cache.getClient(), set by
//                  REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB /
//                  REDIS_PREFIX) unless `client` hands in another.
// store: 'memory'  this process's own — one process, a test. A stop asked for
//                  here is heard here.
//
// Short-lived by design: a record lives KEEP_SECONDS after its run ends, and
// RUNNING_SECONDS while it runs (longer than any run's own time limit). A
// result too large to move through Redis (MAX_SHARED_BYTES, gzipped) is kept
// without it, marked tooLargeToShare: read on another process it says "run
// it again", never a wrong answer.
//
// Redis mode with no client (the app gave none) is a no-op: save returns
// false, load null — exactly a single process's behaviour. A Redis error is
// warned about, never thrown: the work itself goes on.

var zlib = require('zlib');
var cluster = require('cluster');

var KEEP_SECONDS = 10 * 60;
var RUNNING_SECONDS = 2 * 60 * 60;
var MAX_SHARED_BYTES = 16 * 1024 * 1024;
var FINAL_WINDOW_MS = 60 * 1000;

function warn(err) { console.warn('[runs] shared store: ' + (err && err.message)); }

/** A Map whose entries go after their own number of seconds — the memory store's Redis. */
function expiringMap() {
  var items = new Map();
  function alive(key) {
    var e = items.get(key);
    if (!e) return null;
    if (e.until && e.until < Date.now()) { items.delete(key); return null; }
    return e;
  }
  return {
    get: function(key) { var e = alive(key); return e ? e.value : null; },
    set: function(key, value, seconds) { items.set(key, { value: value, until: seconds ? Date.now() + seconds * 1000 : 0 }); },
    has: function(key) { return Boolean(alive(key)); },
    del: function(key) { items.delete(key); }
  };
}

/**
 * @param {object} [opts]
 * @param {'redis'|'memory'} [opts.store='memory']
 * @param {() => object|null} [opts.client] - the ioredis client to use (redis); default @xeplr/utils' cache client
 * @param {string|(() => string)} [opts.prefix='xruns:v1'] - every key and the stop channel start with it. Give each
 *        app its own (an application id) when apps share a Redis.
 */
function RunStore(opts) {
  var o = opts || {};
  this.mode = o.store === 'redis' ? 'redis' : 'memory';
  this._client = this.mode === 'redis'
    ? (typeof o.client === 'function' ? o.client : function() { return require('./cache').getClient(); })
    : function() { return null; };
  this._prefix = typeof o.prefix === 'function' ? o.prefix : function() { return o.prefix || 'xruns:v1'; };
  this._memory = this.mode === 'memory' ? expiringMap() : null;
  this._finals = new Map();          // memory: userId → [{ at, event }]
  this._subscriber = null;
  this._stopHandlers = [];
}

RunStore.KEEP_SECONDS = KEEP_SECONDS;
RunStore.RUNNING_SECONDS = RUNNING_SECONDS;
RunStore.MAX_SHARED_BYTES = MAX_SHARED_BYTES;
RunStore.prototype.KEEP_SECONDS = KEEP_SECONDS;
RunStore.prototype.RUNNING_SECONDS = RUNNING_SECONDS;
RunStore.prototype.MAX_SHARED_BYTES = MAX_SHARED_BYTES;

/**
 * The store an app's setting asks for: XEPLR_RUNS_STORE = redis | memory.
 * Unset in a process that is one of several (a cluster worker) it REFUSES,
 * naming the setting — a run kept in one worker's memory cannot be seen or
 * stopped from the others, and nothing would say so. Unset otherwise: memory.
 * opts: as the constructor's, less `store`.
 */
RunStore.fromEnv = function(opts) {
  var asked = String(process.env.XEPLR_RUNS_STORE || '').trim().toLowerCase();
  if (asked && asked !== 'redis' && asked !== 'memory') {
    throw new Error('XEPLR_RUNS_STORE must be redis or memory (got "' + process.env.XEPLR_RUNS_STORE + '")');
  }
  if (!asked && cluster.isWorker) {
    throw new Error('XEPLR_RUNS_STORE is not set, and this process is one of several (a cluster worker): set it to redis ' +
      '(with REDIS_HOST / REDIS_PORT), so a run started in one process can be followed and stopped from the others.');
  }
  if (asked === 'redis') {
    try { require.resolve('ioredis'); } catch (e) {
      throw new Error('XEPLR_RUNS_STORE=redis needs ioredis: npm install ioredis');
    }
  }
  return new RunStore(Object.assign({}, opts, { store: asked || 'memory' }));
};

/** The client in use, or null (memory, or redis without one). */
RunStore.prototype.client = function() { return this._client(); };

/** Whether runs are kept for other processes to see: redis with a client, or memory (this process is all there is). */
RunStore.prototype.available = function() {
  return this.mode === 'memory' ? true : Boolean(this._client());
};

/** A key under this store's prefix: key('run', id) → '<prefix>:run:<id>'. */
RunStore.prototype.key = function() {
  return [this._prefix()].concat(Array.prototype.slice.call(arguments)).join(':');
};

RunStore.prototype._stopChannel = function() { return this.key('stop'); };

/**
 * Keep what a run says about itself — whatever the caller answers a "how is
 * it going" with, plus whose it is. `record.id` is required.
 */
RunStore.prototype.save = async function(record, seconds) {
  var ttl = seconds || KEEP_SECONDS;
  if (this._memory) { this._memory.set(this.key('run', record.id), JSON.parse(JSON.stringify(record)), ttl); return true; }
  var c = this._client();
  if (!c) return false;
  try {
    var body = zlib.gzipSync(Buffer.from(JSON.stringify(record)));
    if (body.length > MAX_SHARED_BYTES) {
      body = zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, record, { result: null, tooLargeToShare: true }))));
    }
    await c.set(this.key('run', record.id), body, 'EX', ttl);
    return true;
  } catch (err) { warn(err); return false; }
};

/** A run kept by any process, or null. */
RunStore.prototype.load = async function(id) {
  if (!id) return null;
  if (this._memory) return this._memory.get(this.key('run', id));
  var c = this._client();
  if (!c) return null;
  try {
    var buf = await c.getBuffer(this.key('run', id));
    return buf ? JSON.parse(zlib.gunzipSync(buf).toString()) : null;
  } catch (err) { warn(err); return null; }
};

/** How a run ended, for a stream that connects after it was said: kept per user for a minute. */
RunStore.prototype.rememberFinal = async function(userId, event, finishedAt) {
  if (!userId) return;
  var at = finishedAt || Date.now();
  if (this._memory) {
    var list = (this._finals.get(userId) || []).filter(function(f) { return f.at >= Date.now() - FINAL_WINDOW_MS; });
    list.push({ at: at, event: JSON.parse(JSON.stringify(event)) });
    this._finals.set(userId, list);
    return;
  }
  var c = this._client();
  if (!c) return;
  try {
    var k = this.key('final', userId);
    await c.zadd(k, at, JSON.stringify(event));
    await c.zremrangebyscore(k, 0, Date.now() - FINAL_WINDOW_MS);
    await c.expire(k, Math.ceil(FINAL_WINDOW_MS / 1000) + 5);
  } catch (err) { warn(err); }
};

RunStore.prototype.recentFinals = async function(userId, withinMs) {
  if (!userId) return [];
  var since = Date.now() - (withinMs == null ? FINAL_WINDOW_MS : withinMs);
  if (this._memory) {
    return (this._finals.get(userId) || []).filter(function(f) { return f.at >= since; }).map(function(f) { return f.event; });
  }
  var c = this._client();
  if (!c) return [];
  try {
    return (await c.zrangebyscore(this.key('final', userId), since, '+inf')).map(function(s) { return JSON.parse(s); });
  } catch (err) { warn(err); return []; }
};

/** A small JSON value under key(name), for the caller's own bookkeeping (a board's runs). */
RunStore.prototype.getJson = async function(name, fallback) {
  if (this._memory) { var v = this._memory.get(this.key(name)); return v == null ? fallback : v; }
  var c = this._client();
  if (!c) return fallback;
  try { var s = await c.get(this.key(name)); return s == null ? fallback : JSON.parse(s); } catch (err) { warn(err); return fallback; }
};

RunStore.prototype.setJson = async function(name, value, seconds) {
  if (this._memory) { this._memory.set(this.key(name), JSON.parse(JSON.stringify(value)), seconds || RUNNING_SECONDS); return; }
  var c = this._client();
  if (!c) return;
  try { await c.set(this.key(name), JSON.stringify(value), 'EX', seconds || RUNNING_SECONDS); } catch (err) { warn(err); }
};

// ── one at a time, across processes ─────────────────────────────────────

/**
 * Claim `name` for up to `seconds`: true if this caller has it, false if
 * someone (any process) already does. Redis without a client: null — the
 * caller keeps its own in-process guard.
 */
RunStore.prototype.claim = async function(name, seconds) {
  var k = this.key('claim', name);
  if (this._memory) {
    if (this._memory.has(k)) return false;
    this._memory.set(k, String(process.pid), seconds);
    return true;
  }
  var c = this._client();
  if (!c) return null;
  try { return Boolean(await c.set(k, String(process.pid), 'EX', seconds, 'NX')); }
  catch (err) { warn(err); return null; }
};

RunStore.prototype.release = async function(name) {
  var k = this.key('claim', name);
  if (this._memory) { this._memory.del(k); return; }
  var c = this._client();
  if (!c) return;
  try { await c.del(k); } catch (err) { warn(err); }
};

// ── the stop switch, from any process ───────────────────────────────────

/**
 * Ask whichever process runs it to stop it. `kind` says whose work it is
 * ('import', 'run', 'move' — the caller's own names). Every process hears it;
 * the one that has the work stops it. False when it could not be said.
 */
RunStore.prototype.requestStop = async function(kind, id, message, extra) {
  var msg = { kind: kind, id: id, message: message || null, extra: extra || null };
  if (this._memory) { this._deliver(msg); return true; }
  var c = this._client();
  if (!c) return false;
  try {
    await c.publish(this._stopChannel(), JSON.stringify(msg));
    return true;
  } catch (err) { warn(err); return false; }
};

/** handler({ kind, id, message, extra }) — called in every process for every stop request. */
RunStore.prototype.onStop = function(handler) {
  this._stopHandlers.push(handler);
  this.listen();
};

RunStore.prototype._deliver = function(msg) {
  this._stopHandlers.forEach(function(h) { try { h(msg); } catch (err) { warn(err); } });
};

RunStore.prototype.listen = function() {
  if (this._memory || this._subscriber) return;
  var c = this._client();
  if (!c) return;
  var self = this;
  var channel = this._stopChannel();
  // A subscribed Redis connection can do nothing else, so it is its own.
  this._subscriber = c.duplicate();
  this._subscriber.on('error', warn);
  this._subscribed = this._subscriber.subscribe(channel).catch(warn);
  this._subscriber.on('message', function(ch, text) {
    if (ch !== channel) return;
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    self._deliver(msg);
  });
};

/** Ready to hear stops: resolves once the subscription is in place (redis), at once otherwise. */
RunStore.prototype.listening = function() {
  return this._subscribed || Promise.resolve();
};

RunStore.prototype.close = async function() {
  if (this._subscriber) { try { await this._subscriber.quit(); } catch (e) { /* closing anyway */ } }
  this._subscriber = null;
  this._subscribed = null;
  this._stopHandlers = [];
};

module.exports = RunStore;
