let _baseUrl = null;

/**
 * Configure the logger client.
 * @param {object} config
 * @param {string} config.url - Logs service base URL (e.g. http://localhost:19005)
 */
function configureLogger(config) {
  _baseUrl = config.url;
}

function getBaseUrl() {
  return _baseUrl || process.env.LOGS_URL || 'http://localhost:19005';
}

async function createSession({ source, action }) {
  var res = await fetch(getBaseUrl() + '/internal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, action })
  });
  if (!res.ok) throw new Error('Failed to create log session: ' + res.statusText);
  return res.json();
}

async function log(sessionId, level, message, metadata) {
  var res = await fetch(getBaseUrl() + '/internal/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, level, message, metadata })
  });
  if (!res.ok) throw new Error('Failed to log: ' + res.statusText);
  return res.json();
}

async function closeSession(sessionId) {
  var res = await fetch(getBaseUrl() + '/internal/sessions/' + sessionId + '/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error('Failed to close session: ' + res.statusText);
  return res.json();
}

async function getSessionLogs(sessionId) {
  var res = await fetch(getBaseUrl() + '/internal/sessions/' + sessionId);
  if (!res.ok) throw new Error('Failed to get logs: ' + res.statusText);
  return res.json();
}

module.exports = { configureLogger, createSession, log, closeSession, getSessionLogs };
