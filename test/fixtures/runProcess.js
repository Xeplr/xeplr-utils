// One API process, as far as runs go: a RunRegistry on the shared Redis store,
// driven by its parent over IPC. Two of these are two processes of one app.
var RunStore = require('../../lib/runStore');
var RunRegistry = require('../../lib/runRegistry');

var store = new RunStore({ store: 'redis', prefix: process.env.RUNS_TEST_PREFIX });
var runs = new RunRegistry({ name: 'test', store: store, idPrefix: 'tst_' });
var heard = [];

function answer(msg, value) { process.send({ reply: msg.seq, value: value }); }

process.on('message', async function(msg) {
  try {
    if (msg.cmd === 'ready') { await store.listening(); return answer(msg, process.pid); }
    if (msg.cmd === 'start') {
      // Work that goes on until it is stopped (or `rounds` pass), saying how far.
      var id = runs.start(async function(onProgress, signal) {
        for (var i = 1; i <= (msg.rounds || 1000); i++) {
          if (signal.aborted) throw new Error('aborted');
          onProgress({ round: i });
          await new Promise(function(r) { setTimeout(r, 20); });
        }
        return { rounds: msg.rounds };
      }, { userId: msg.userId, kind: 'test', onChange: function(v) { heard.push(v.status); } });
      return answer(msg, id);
    }
    if (msg.cmd === 'view') return answer(msg, await runs.view(msg.id, msg.userId));
    if (msg.cmd === 'stop') return answer(msg, await runs.stop(msg.id, msg.userId, msg.reason));
    if (msg.cmd === 'heard') return answer(msg, heard);
    if (msg.cmd === 'exit') { await store.close(); await require('../../lib/cache').getClient().quit(); process.exit(0); }
  } catch (err) { answer(msg, { error: err.message }); }
});
process.send({ up: true });
