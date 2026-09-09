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

var { classifySqlError } = require('./sql-error');

// ─────────────────────────────────────────────────────────────────────────
// SqlQueue — in-memory concurrent worker pool for SQL execution.
//
// Movement-scoped: every item carries a `movementId`. Rollback is by
// movementId. Aborting drops all queued items for one movement without
// affecting others.
//
// Retry / bisect / drop / abort behavior:
//   - Up to `maxAttempts` per item (default 3); errorExecutor decides
//     what to do on each failure ('retry' | 'bisect' | 'error-table' |
//     'drop' | 'fatal').
//   - 'bisect' splits `item.meta.rows` in half, regenerates two child
//     SQL statements via `item.meta.rowsToSql(rows)`, and re-enqueues both.
//   - 'error-table' calls `onErrorTable({item, error, rowNum})` and counts
//     as a drop.
//   - `maxConsecutiveDrops` (default 5) drops within the same movement
//     → auto-abort that movement.
//   - 'fatal' → auto-abort that movement immediately.
//
// Backpressure: total serialized item bytes ≤ `maxMemoryMB * 1024 * 1024`
// (default 200MB high water). `addToQueue` returns a promise that awaits
// when over the ceiling, resumes at 75% low water.
//
// Encrypted connections: `connections: { name: encryptedString | plainConfig }`
// + `encryptionKey`. String values are decrypted via
// `@xeplr/utils/isomorphic/crypto` on first use and cached.
class SqlQueue {
  constructor(options) {
    options = options || {};
    if (typeof options.executor !== 'function') {
      throw new Error('SqlQueue: options.executor is required (async (item, resolvedConn) => void)');
    }
    this.executor           = options.executor;
    this.errorExecutor      = options.errorExecutor      || defaultErrorExecutor;
    this.onErrorTable       = options.onErrorTable       || function() {};
    this.onMovementAbort    = options.onMovementAbort    || function() {};
    this.concurrency        = options.concurrency        || 4;
    this.maxAttempts        = options.maxAttempts        || 3;
    this.maxConsecutiveDrops= options.maxConsecutiveDrops|| 5;
    this.maxMemoryBytes     = (options.maxMemoryMB       || 200) * 1024 * 1024;
    this.lowMemoryBytes     = Math.floor(this.maxMemoryBytes * 0.75);
    this.retryDelaysMs      = options.retryDelaysMs      || [5000, 15000, 45000];
    this.connections        = options.connections        || {};
    this.encryptionKey      = options.encryptionKey      || null;

    this._items       = [];
    this._itemId      = 0;
    this._byteTotal   = 0;
    this._inFlight    = 0;
    this._pendingRetries = 0;               // items awaiting their retry setTimeout
    this._stopped     = false;
    this._paused      = false;
    this._pressureWaiters = [];
    this._idleWaiters = [];
    this._resolved    = {};                 // decrypted connection cache
    this._movements   = new Map();          // movementId → state

    this._workers = [];
    for (var i = 0; i < this.concurrency; i++) {
      this._workers.push(this._workerLoop());
    }
  }

  // Enqueue an item. Awaits when the queue is over its memory ceiling.
  // Item shape:
  //   { movementId, connection, sql?, meta: { rows?, rowsToSql?, errorTable?, ... }, attempt? }
  // `sql` is generated from `meta.rowsToSql(meta.rows)` if not supplied.
  async addToQueue(item) {
    if (this._stopped) throw new Error('SqlQueue is stopped');
    if (!item || !item.movementId) throw new Error('addToQueue: item.movementId is required');
    if (!item.sql && item.meta && typeof item.meta.rowsToSql === 'function' && Array.isArray(item.meta.rows)) {
      var builtA = item.meta.rowsToSql(item.meta.rows);
      if (typeof builtA === 'string') { item.sql = builtA; }
      else if (builtA && builtA.sql)  { item.sql = builtA.sql; if (builtA.params != null) item.params = builtA.params; }
    }
    if (!item.sql) throw new Error('addToQueue: item.sql is required (or provide meta.rowsToSql + meta.rows)');

    while (this._byteTotal >= this.maxMemoryBytes) {
      await new Promise(function(res) { this._pressureWaiters.push(res); }.bind(this));
    }

    item.id      = ++this._itemId;
    item.attempt = item.attempt || 0;
    item.bytes   = approximateBytes(item);
    this._byteTotal += item.bytes;
    this._items.push(item);

    var state = this._stateFor(item.movementId);
    state.queued++;
  }

  // Abort a movement. Drops queued items for that movement and prevents
  // in-flight retries. Emits onMovementAbort. In-flight SQLs are allowed
  // to settle — caller runs uploader.rollback() to clean the DB.
  abort(movementId, reason) {
    var state = this._stateFor(movementId);
    if (state.aborted) return;
    state.aborted = true;
    state.abortReason = reason || 'aborted';

    var kept = [];
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      if (it.movementId === movementId) {
        this._byteTotal -= it.bytes;
        state.queued--;
        state.dropped += rowsOf(it);
        state.statementsDropped++;
      } else {
        kept.push(it);
      }
    }
    this._items = kept;
    this._releaseBackpressure();

    try { this.onMovementAbort({ movementId: movementId, reason: state.abortReason }); }
    catch (e) { /* swallow — never let a hook block */ }
  }

  // Drop everything queued for a movement that has already aborted.
  //
  // Same bookkeeping as abort()'s own sweep — these rows are lost either way,
  // and a count that omits them is the same lie by a slower route.
  _purgeAborted() {
    if (!this._items.length) return;
    var kept = [];
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      var st = this._stateFor(it.movementId);
      if (st.aborted) {
        this._byteTotal -= it.bytes;
        st.queued--;
        st.dropped += rowsOf(it);
        st.statementsDropped++;
      } else {
        kept.push(it);
      }
    }
    if (kept.length !== this._items.length) {
      this._items = kept;
      this._releaseBackpressure();
    }
  }

  // Stats: per-movement if id passed, else global.
  stats(movementId) {
    if (movementId) {
      var s = this._movements.get(movementId);
      return s ? Object.assign({}, s) : null;
    }
    var total = { queued: this._items.length, inFlight: this._inFlight, bytes: this._byteTotal, movements: this._movements.size };
    return total;
  }

  // Resolve when the queue drains AND no items are in flight AND no
  // retry is pending. Useful after a spool ends and before checking
  // final counts.
  async drain() {
    while (this._items.length > 0 || this._inFlight > 0 || this._pendingRetries > 0) {
      await new Promise(function(res) { this._idleWaiters.push(res); }.bind(this));
    }
  }

  pause()   { this._paused = true; }
  resume()  { if (this._paused) { this._paused = false; this._kick(); } }
  stop()    { this._stopped = true; this._paused = true; this._releaseBackpressure(); }

  // ─── internal ─────────────────────────────────────────────────────────
  _stateFor(movementId) {
    var s = this._movements.get(movementId);
    if (!s) {
      // `completed` and `dropped` count ROWS, not statements.
      //
      // They counted statements, and one statement is a multi-row INSERT — so a
      // 12,000-row movement in three batches reported "completed: 3". That
      // number is surfaced to people as ROWS LOADED (import_meta.completed, and
      // the import history page reading it), which meant every import in the
      // product has been reporting its batch count as a row count.
      //
      // Every queued item already carries meta.rowCount; the counters just were
      // not using it. Statements are counted separately for anyone who wants
      // them — see statements/statementsDropped.
      s = {
        movementId: movementId, queued: 0, inFlight: 0,
        completed: 0, dropped: 0,
        statements: 0, statementsDropped: 0,
        aborted: false, abortReason: null, consecutiveDrops: 0
      };
      this._movements.set(movementId, s);
    }
    return s;
  }

  async _workerLoop() {
    while (!this._stopped) {
      if (this._paused || this._items.length === 0 || this._byteTotal === 0) {
        await sleep(25);
        this._maybeSignalIdle();
        continue;
      }
      // Pick the first item whose movement isn't aborted.
      var idx = -1;
      for (var i = 0; i < this._items.length; i++) {
        var m = this._items[i].movementId;
        if (!this._stateFor(m).aborted) { idx = i; break; }
      }
      // NOTHING LEFT THAT IS ALLOWED TO RUN — every queued item belongs to a
      // movement that has aborted. They can never be picked up (this loop
      // skips aborted movements) and nothing else removes them, so without
      // this they sit in _items forever and drain() waits on a queue that
      // will never empty: a movement that has already finished its work and
      // hangs, with no summary line ever written.
      //
      // Reachable because abort() clears what is queued AT THAT MOMENT, while
      // items keep arriving after it — a bisect re-enqueueing children of an
      // in-flight failure, or a still-running spool adding the next batch.
      // Masked until deterministic errors stopped being retried: the retry
      // backoff used to hold those children in _pendingRetries (which DOES
      // check aborted) rather than in the queue.
      if (idx < 0) {
        this._purgeAborted();
        await sleep(25);
        this._maybeSignalIdle();
        continue;
      }

      var item = this._items.splice(idx, 1)[0];
      this._byteTotal -= item.bytes;
      this._releaseBackpressure();

      var state = this._stateFor(item.movementId);
      state.queued--;
      state.inFlight++;
      this._inFlight++;

      try { await this._processItem(item, state); }
      catch (e) { /* processItem never throws — belt and braces */ }
      finally { state.inFlight--; this._inFlight--; this._maybeSignalIdle(); }
    }
  }

  async _processItem(item, state) {
    if (state.aborted) return;

    var conn;
    try { conn = await this._resolveConnection(item.connection); }
    catch (err) {
      // Connection resolution failure = fatal for the movement.
      state.dropped += rowsOf(item);
      state.statementsDropped++;
      this.abort(item.movementId, 'connection_resolve_failed: ' + err.message);
      return;
    }

    item.attempt++;
    try {
      await this.executor(item, conn);
      state.completed += rowsOf(item);
      state.statements++;
      state.consecutiveDrops = 0;
      return;
    } catch (err) {
      var attemptedFinal = item.attempt >= this.maxAttempts;
      var decision = await this.errorExecutor({ item: item, error: err, attempt: item.attempt, isFinal: attemptedFinal });
      decision = decision || {};

      if (decision.decision === 'retry' && !attemptedFinal && !state.aborted) {
        // Delays indexed by "which retry": 1st retry uses [0], 2nd uses [1], etc.
        var delayIdx = Math.min(item.attempt - 1, this.retryDelaysMs.length - 1);
        var delay = decision.delayMs != null ? decision.delayMs : this.retryDelaysMs[delayIdx];
        this._pendingRetries++;
        setTimeout(function() {
          this._pendingRetries--;
          if (!state.aborted && !this._stopped) {
            item.bytes = approximateBytes(item);
            this._byteTotal += item.bytes;
            this._items.push(item);
            state.queued++;
          }
          this._maybeSignalIdle();
        }.bind(this), delay);
        return;
      }

      if (decision.decision === 'bisect' && item.meta && Array.isArray(item.meta.rows) && item.meta.rows.length > 1) {
        // Not into an aborted movement. Splitting a batch to find out which
        // half is bad is only worth doing if the halves can still run, and
        // they cannot — the movement has given up. Counted as dropped,
        // because that is what happens to them.
        if (state.aborted) {
          state.dropped += rowsOf(item);
          state.statementsDropped++;
          return;
        }
        var mid = Math.floor(item.meta.rows.length / 2);
        var left = cloneItemWithRows(item, item.meta.rows.slice(0, mid));
        var right = cloneItemWithRows(item, item.meta.rows.slice(mid));
        await this.addToQueue(left);
        await this.addToQueue(right);
        return;
      }

      if (decision.decision === 'fatal') {
        this.abort(item.movementId, 'fatal: ' + (decision.reason || err.message));
        return;
      }

      // 'error-table' | 'drop' | anything else past max attempts → drop
      state.dropped += rowsOf(item);
      state.statementsDropped++;
      state.consecutiveDrops++;
      try {
        this.onErrorTable({
          item: item,
          error: err,
          rowNum: item.meta && item.meta.rowNum,
          reason: decision.reason || err.message,
          // The database's OWN identifier for what went wrong ('23502', 515,
          // 'ER_BAD_NULL_ERROR') and whether it was ever worth retrying —
          // facts a log analyzer can group by, where the message is prose
          // that varies by server version and locale.
          errorCode: decision.errorCode != null ? decision.errorCode : null,
          errorKind: decision.errorKind || null,
          attempts: item.attempt
        });
      } catch (_) { /* swallow */ }
      if (state.consecutiveDrops >= this.maxConsecutiveDrops) {
        this.abort(item.movementId, 'consecutive_drops_exceeded');
      }
    }
  }

  async _resolveConnection(name) {
    if (this._resolved[name]) return this._resolved[name];
    var raw = this.connections[name];
    if (raw === undefined) throw new Error('SqlQueue: unknown connection "' + name + '"');
    if (typeof raw === 'object') { this._resolved[name] = raw; return raw; }
    if (typeof raw !== 'string')  throw new Error('SqlQueue: connection "' + name + '" must be encrypted string or plain object');
    if (!this.encryptionKey)      throw new Error('SqlQueue: encryptionKey required to decrypt connection "' + name + '"');
    var { decrypt } = require('../isomorphic/crypto');
    var decrypted = await decrypt(raw, this.encryptionKey);
    var config = JSON.parse(decrypted);
    this._resolved[name] = config;
    return config;
  }

  _releaseBackpressure() {
    if (this._byteTotal <= this.lowMemoryBytes && this._pressureWaiters.length) {
      var waiters = this._pressureWaiters;
      this._pressureWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i]();
    }
  }

  _maybeSignalIdle() {
    if (this._items.length === 0 && this._inFlight === 0 && this._pendingRetries === 0 && this._idleWaiters.length) {
      var waiters = this._idleWaiters;
      this._idleWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i]();
    }
  }

  _kick() { /* worker loops poll — nothing to do */ }
}

function defaultErrorExecutor(ctx) {
  // Default: retry until final attempt, then route the row (or the whole
  // batch if not bisectable) to the error table.
  //
  // EXCEPT when the database has already given its final answer. A NOT NULL
  // violation, a failed cast or a missing column fails identically however
  // many times it is sent, so retrying one buys nothing and costs the whole
  // backoff — 65 seconds by default, per item, and a bisect resets its
  // children to attempt 0 so that multiplies down the tree. Measured on a
  // 1000-row movement into a NOT NULL column: 105 seconds, nearly all of it
  // asleep, for a verdict available immediately.
  //
  // Straight to bisect instead, which is the fast path to the SAME outcome —
  // it isolates which rows are bad instead of waiting to find out.
  // classifySqlError treats anything it does not recognise as retryable, so
  // this only ever skips waiting when the error is known to be deterministic.
  var verdict = classifySqlError(ctx.error);
  var bisectable = ctx.item.meta && Array.isArray(ctx.item.meta.rows) && ctx.item.meta.rows.length > 1;

  if (!verdict.retryable) {
    if (bisectable) return { decision: 'bisect', errorCode: verdict.code, errorKind: verdict.kind };
    return {
      decision: 'error-table',
      reason: ctx.error && ctx.error.message,
      errorCode: verdict.code,
      errorKind: verdict.kind
    };
  }

  if (!ctx.isFinal) return { decision: 'retry' };
  if (bisectable) return { decision: 'bisect', errorCode: verdict.code, errorKind: verdict.kind };
  return {
    decision: 'error-table',
    reason: ctx.error && ctx.error.message,
    errorCode: verdict.code,
    errorKind: verdict.kind
  };
}

function cloneItemWithRows(item, rows) {
  var clonedMeta = Object.assign({}, item.meta, { rows: rows, rowCount: rows.length });
  var next = {
    movementId: item.movementId,
    connection: item.connection,
    meta:       clonedMeta,
    attempt:    0
  };
  if (typeof clonedMeta.rowsToSql === 'function') {
    var built = clonedMeta.rowsToSql(rows);
    if (typeof built === 'string') { next.sql = built; next.params = item.params; }
    else if (built && built.sql)   { next.sql = built.sql; next.params = built.params; }
  } else {
    next.sql = item.sql; next.params = item.params;
  }
  return next;
}

// Rows in one queued item. The uploader puts the real count on meta; anything
// that queues without one counts as a single row, which keeps a caller that
// enqueues row-at-a-time honest rather than reporting zero.
function rowsOf(item) {
  var n = item && item.meta && item.meta.rowCount;
  return typeof n === 'number' && n >= 0 ? n : 1;
}

function approximateBytes(item) {
  try { return JSON.stringify(item).length; } catch (_) { return 128; }
}

function sleep(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }

module.exports = Queue;
module.exports.Queue = Queue;
module.exports.SqlQueue = SqlQueue;
module.exports.classifySqlError = classifySqlError;
