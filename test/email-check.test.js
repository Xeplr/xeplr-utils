// checkEmail — what a service's startup summary says about email. Never throws,
// never sends a message.
var test = require('node:test');
var assert = require('node:assert/strict');
var net = require('node:net');

var ENV_KEYS = ['EMAIL_PROVIDER', 'SMTP_OPTIONS', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SES_FROM', 'AZURE_COMMUNICATION_CONNECTION_STRING', 'AZURE_EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_IGNORE_TLS', 'BREVO_API_KEY', 'BREVO_FROM_EMAIL'];

function fresh(env) {
  ENV_KEYS.forEach(function(k) { delete process.env[k]; });
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve('../lib/email')];
  return require('../lib/email');
}

// Just enough SMTP for nodemailer's verify(): greeting, EHLO, QUIT.
function fakeSmtp() {
  return new Promise(function(resolve) {
    var server = net.createServer(function(socket) {
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', function(chunk) {
        String(chunk).split('\r\n').filter(Boolean).forEach(function(line) {
          if (/^(EHLO|HELO)/i.test(line)) socket.write('250-fake\r\n250 OK\r\n');
          else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('250 OK\r\n');
        });
      });
    });
    server.listen(0, '127.0.0.1', function() { resolve(server); });
  });
}

test('no provider: not configured, and says which setting', async function() {
  var result = await fresh().checkEmail();
  assert.deepEqual(result, { ok: false, provider: null, detail: 'not configured (EMAIL_PROVIDER is not set)' });
});

test('smtp without a host or a from address names the missing setting', async function() {
  assert.match((await fresh({ EMAIL_PROVIDER: 'smtp' }).checkEmail()).detail, /SMTP_HOST/);
  assert.match((await fresh({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'localhost' }).checkEmail()).detail, /SMTP_FROM/);
});

test('smtp that answers: connected', async function() {
  var server = await fakeSmtp();
  try {
    var port = server.address().port;
    var result = await fresh({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'app@example.com', SMTP_IGNORE_TLS: 'true' }).checkEmail();
    assert.deepEqual(result, { ok: true, provider: 'smtp', detail: '127.0.0.1:' + port + ', connected' });
  } finally {
    server.close();
  }
});

test('smtp that is not there: not ok, with the reason — and no throw', async function() {
  var server = await fakeSmtp();
  var port = server.address().port;
  server.close();
  var result = await fresh({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'app@example.com' }).checkEmail({ timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /ECONNREFUSED|connect/i);
});

test('an unknown provider is named', async function() {
  var result = await fresh({ EMAIL_PROVIDER: 'pigeon' }).checkEmail();
  assert.equal(result.ok, false);
  assert.match(result.detail, /unknown provider "pigeon"/);
});

test('smtp options from SMTP_OPTIONS reach the connection check too', async function() {
  var server = await fakeSmtp();
  try {
    var port = server.address().port;
    var result = await fresh({
      EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'app@example.com',
      SMTP_OPTIONS: JSON.stringify({ ignoreTLS: true, name: 'checker', tls: { rejectUnauthorized: false } })
    }).checkEmail();
    assert.equal(result.ok, true, result.detail);
  } finally {
    server.close();
  }
});

test('smtp that never answers times out rather than hanging startup', async function() {
  var silent = net.createServer(function() { /* accepts, says nothing */ });
  await new Promise(function(r) { silent.listen(0, '127.0.0.1', r); });
  try {
    var port = silent.address().port;
    var result = await fresh({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'app@example.com' }).checkEmail({ timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.match(result.detail, /no answer from 127\.0\.0\.1 within 300ms/);
  } finally {
    silent.close();
  }
});

test('brevo: settings named when missing, the API key asked about when present', async function() {
  assert.match((await fresh({ EMAIL_PROVIDER: 'brevo' }).checkEmail()).detail, /BREVO_API_KEY/);
  assert.match((await fresh({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k' }).checkEmail()).detail, /BREVO_FROM_EMAIL/);

  var realFetch = global.fetch;
  var asked = null;
  try {
    global.fetch = async function(url, opts) { asked = { url: url, key: opts.headers['api-key'] }; return { ok: true, status: 200 }; };
    var good = await fresh({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'good', BREVO_FROM_EMAIL: 'a@b.c' }).checkEmail();
    assert.deepEqual(good, { ok: true, provider: 'brevo', detail: 'API key accepted' });
    assert.deepEqual(asked, { url: 'https://api.brevo.com/v3/account', key: 'good' });

    global.fetch = async function() { return { ok: false, status: 401 }; };
    var bad = await fresh({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'bad', BREVO_FROM_EMAIL: 'a@b.c' }).checkEmail();
    assert.deepEqual(bad, { ok: false, provider: 'brevo', detail: 'Brevo refused the API key (401)' });

    global.fetch = async function() { throw new Error('getaddrinfo ENOTFOUND api.brevo.com'); };
    var offline = await fresh({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'a@b.c' }).checkEmail();
    assert.equal(offline.ok, false);
    assert.match(offline.detail, /ENOTFOUND/);
  } finally {
    global.fetch = realFetch;
  }
});

test('aws and azure: settings present or named as missing, never contacted', async function() {
  var awsMissing = await fresh({ EMAIL_PROVIDER: 'aws' }).checkEmail();
  assert.equal(awsMissing.ok, false);
  assert.match(awsMissing.detail, /missing region, accessKeyId, secretAccessKey, from/);
  var aws = await fresh({ EMAIL_PROVIDER: 'aws', AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SES_FROM: 'a@b.c' }).checkEmail();
  assert.deepEqual(aws, { ok: true, provider: 'aws', detail: 'settings present, not contacted' });

  assert.equal((await fresh({ EMAIL_PROVIDER: 'azure' }).checkEmail()).ok, false);
  var azure = await fresh({ EMAIL_PROVIDER: 'azure', AZURE_COMMUNICATION_CONNECTION_STRING: 'x', AZURE_EMAIL_FROM: 'a@b.c' }).checkEmail();
  assert.deepEqual(azure, { ok: true, provider: 'azure', detail: 'settings present, not contacted' });
  ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SES_FROM', 'AZURE_COMMUNICATION_CONNECTION_STRING', 'AZURE_EMAIL_FROM', 'SMTP_OPTIONS'].forEach(function(k) { delete process.env[k]; });
});

test('a config given in code (configureEmail) is what gets checked', async function() {
  var email = fresh();
  email.configureEmail({ provider: 'aws', aws: { region: 'r', accessKeyId: 'a', secretAccessKey: 's', from: 'a@b.c' } });
  assert.equal((await email.checkEmail()).ok, true);
});

test('sending still uses the same transport options: a message reaches the server', async function() {
  var received = '';
  var server = net.createServer(function(socket) {
    var inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', function(chunk) {
      var text = String(chunk);
      if (inData) {
        received += text;
        if (/\r\n\.\r\n$/.test(received)) { inData = false; socket.write('250 queued\r\n'); }
        return;
      }
      text.split('\r\n').filter(Boolean).forEach(function(line) {
        if (/^(EHLO|HELO)/i.test(line)) socket.write('250-fake\r\n250 OK\r\n');
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go ahead\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      });
    });
  });
  await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
  try {
    var email = fresh({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'app@example.com', SMTP_IGNORE_TLS: 'true' });
    email.configureFromEnv();
    await email.sendEmail(['someone@example.com'], 'Activate your account', '<p>hello</p>');
    assert.match(received, /Subject: Activate your account/);
  } finally {
    server.close();
  }
});
