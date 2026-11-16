// RUNS IN THE BACKGROUND, FOLLOWED AND STOPPED FROM ANY PROCESS.
//
// Work that takes minutes (an import, a check of a big file) answers its
// request at once with a run id; the page then follows the run. With several
// processes the follow-up and the ✕ may land on any of them — so the work and
// its stop switch stay where it runs, and what it says about itself is kept in
// a RunStore every process reads.
//
//   var runs = new RunRegistry({ name: 'imports', store: RunStore.fromEnv(), idPrefix: 'imp_' })
//   var id = runs.start(function(onProgress, signal) { ... }, { userId, kind: 'import', onChange })
//   await runs.view(id, userId)        // { id, kind, status, progress, result, error, startedAt, finishedAt } | null
//   await runs.stop(id, userId)        // true if it was running — wherever it runs
//
// status: running | complete | error | stopped. A run is only ever shown to,
// and stopped by, the person who started it.
//
// onChange(view) hears the run as it moves — at most once every
// SAY_EVERY_MS while it runs, and once when it ends — in the process doing
// the work: that is where an app tells its event stream. The same moments
// write the shared record, so a process that asks sees what was said.
//
// A run's work dies with its process. Its record then reads "running" until
// RUNNING_SECONDS pass — a run's own time limit (timeLimitMs) should be far
// shorter. The durable account of the work is the caller's own (an import's
// record in its table), never this.

var crypto = require('crypto');
var RunStore = require('./runStore');

var SAY_EVERY_MS = 1000;
var KEEP_MS = 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.name - whose runs these are ('imports'): a stop asked for is heard only by this registry
 * @param {RunStore} [opts.store] - where runs are kept for every process; default a memory store (one process)
 * @param {string} [opts.idPrefix='run_']
 * @param {number} [opts.keepMs=3600000] - how long a finished run is kept for its page to read the ending
 */
function RunRegistry(opts) {
  var o = opts || {};
  if (!o.name) throw new Error('RunRegistry needs a name');
  this.name = o.name;
  this.store = o.store || new RunStore({ store: 'memory' });
  this.idPrefix = o.idPrefix || 'run_';
  this.keepSeconds = Math.ceil((o.keepMs || KEEP_MS) / 1000);
  this._local = new Map();
  var self = this;
  this.store.onStop(function(msg) {
    if (msg && msg.kind === 'registry:' + self.name) self._stopHere(msg.id, msg.message);
  });
}

RunRegistry.SAY_EVERY_MS = SAY_EVERY_MS;

/** What a page sees of a run. */
function viewOf(run) {
  return {
    id: run.id,
    kind: run.kind,
    userId: run.userId,
    status: run.status,
    progress: run.progress,
    result: run.result,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
}

function shown(view) {
  var v = Object.assign({}, view);
  delete v.userId;
  return v;
}

/**
 * Start `work(onProgress, signal)` in the background.
 *
 * @param {Function} work
 * @param {object} [opts] - { userId, kind?, timeLimitMs?, timeLimitMessage?, onChange? }
 * @returns {string} the run id
 */
RunRegistry.prototype.start = function(work, opts) {
  var o = opts || {};
  var self = this;
  var run = {
    id: this.idPrefix + crypto.randomBytes(10).toString('hex'),
    userId: o.userId == null ? null : String(o.userId),
    kind: o.kind || null,
    status: 'running',
    progress: null,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    controller: new AbortController(),
    timer: null,
    saidAt: 0,
    onChange: typeof o.onChange === 'function' ? o.onChange : null
  };
  this._local.set(run.id, run);
  this.store.save(viewOf(run), this.store.RUNNING_SECONDS);

  if (o.timeLimitMs) {
    run.timer = setTimeout(function() {
      self._stopHere(run.id, o.timeLimitMessage || ('Stopped after ' + Math.round(o.timeLimitMs / 60000) + ' minutes, its time limit.'));
    }, o.timeLimitMs);
    if (run.timer.unref) run.timer.unref();
  }

  Promise.resolve().then(function() {
    return work(function(progress) {
      run.progress = progress;
      if (Date.now() - run.saidAt >= SAY_EVERY_MS) self._say(run);
    }, run.controller.signal);
  }).then(function(result) {
    self._settle(run, run.controller.signal.aborted ? 'stopped' : 'complete', result, null);
  }, function(err) {
    self._settle(run, run.controller.signal.aborted ? 'stopped' : 'error', null, (err && err.message) || String(err));
  });
  return run.id;
};

/** The run as it is now: to the shared record, and to onChange. Neither failing fails the run. */
RunRegistry.prototype._say = function(run) {
  run.saidAt = Date.now();
  var view = viewOf(run);
  this.store.save(view, run.status === 'running' ? this.store.RUNNING_SECONDS : this.keepSeconds);
  if (run.onChange) { try { run.onChange(shown(view)); } catch (e) { /* the page can still ask */ } }
};

RunRegistry.prototype._settle = function(run, status, result, error) {
  if (run.timer) clearTimeout(run.timer);
  run.status = status;
  run.result = result;
  run.error = status === 'stopped' ? (run.stopReason || 'Stopped') : error;
  run.finishedAt = Date.now();
  this._say(run);
  var local = this._local;
  var forget = setTimeout(function() { local.delete(run.id); }, this.keepSeconds * 1000);
  if (forget.unref) forget.unref();
};

/** Stop a run if THIS process has it. */
RunRegistry.prototype._stopHere = function(id, reason) {
  var run = this._local.get(id);
  if (!run || run.status !== 'running') return false;
  run.stopReason = reason || 'Stopped';
  run.controller.abort();
  return true;
};

/**
 * A run as its page sees it — from this process or any other — or null when
 * there is none for this user.
 */
RunRegistry.prototype.view = async function(id, userId) {
  var who = userId == null ? null : String(userId);
  var here = this._local.get(id);
  var view = here ? viewOf(here) : await this.store.load(id);
  if (!view || view.userId !== who || String(view.id || '').indexOf(this.idPrefix) !== 0) return null;
  return shown(view);
};

/**
 * Ask a running run to stop, wherever it runs: true if it was running (and
 * so is now told to stop), false when this user has no such running run.
 */
RunRegistry.prototype.stop = async function(id, userId, reason) {
  var view = await this.view(id, userId);
  if (!view || view.status !== 'running') return false;
  if (this._stopHere(id, reason)) return true;
  return this.store.requestStop('registry:' + this.name, id, reason || 'Stopped');
};

module.exports = RunRegistry;
