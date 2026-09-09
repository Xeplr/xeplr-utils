// `nodemailer` is an optional peer dep — lazy-loaded so projects that
// don't send email don't have to install it (or its transitive deps).
let _nodemailer = null;
function loadNodemailer() {
  if (_nodemailer) return _nodemailer;
  try { _nodemailer = require('nodemailer'); return _nodemailer; }
  catch (e) {
    var err = new Error(
      "@xeplr/utils/lib/email: 'nodemailer' is not installed. Run `npm install nodemailer` " +
      "in your project. It's an optional peer dependency — only required if you send email."
    );
    err.cause = e;
    throw err;
  }
}

const fs = require('fs');
const path = require('path');

let _config = null;
let _queue = null;
let _deadLetterQueue = null;

/**
 * Configure the email service.
 * @param {object} config
 * @param {string} config.provider - 'smtp' | 'aws' | 'azure' | 'brevo'
 * @param {object} [config.smtp] - { host, port, user, pass, from, secure }
 * @param {object} [config.aws] - { region, accessKeyId, secretAccessKey, from }
 * @param {object} [config.azure] - { connectionString, from }
 * @param {object} [config.brevo] - { apiKey, fromEmail, fromName }
 * @param {boolean} [config.useQueue=false] - Queue emails with retry instead of sending immediately
 * @param {number} [config.maxRetries=3] - Max retry attempts per email
 * @param {number} [config.retryIntervalInSeconds=60] - Seconds between retry attempts
 * @param {string} [config.store='memory'] - Queue store: 'memory' or 'redis'
 * @param {string} [config.redisKey='xeplr:queue:email'] - Redis key for email queue
 */
function configureEmail(config) {
  _config = config;

  if (config.useQueue) {
    var Queue = require('./queue');
    var maxRetries = config.maxRetries || 3;
    var storeType = config.store || 'memory';

    _deadLetterQueue = new Queue({
      store: storeType,
      redisKey: config.deadLetterKey || 'xeplr:queue:email:dead',
      autoIntervalInSeconds: 0,
      maxEmptyTicks: 0
    });

    _queue = new Queue({
      store: storeType,
      redisKey: config.redisKey || 'xeplr:queue:email',
      autoIntervalInSeconds: config.retryIntervalInSeconds || 60,
      maxEmptyTicks: 0,
      action: async function(item) {
        try {
          await _sendDirect(item.to, item.subject, item.html, item.cc, item.attachments);
        } catch (err) {
          var attempt = (item._retries || 0) + 1;
          if (attempt < maxRetries) {
            console.error('[xeplr-email] send failed (attempt ' + attempt + '/' + maxRetries + '): ' + err.message + ' — will retry');
            _queue.addToQueue({ to: item.to, subject: item.subject, html: item.html, cc: item.cc, attachments: item.attachments, _retries: attempt });
          } else {
            console.error('[xeplr-email] send failed after ' + maxRetries + ' attempts, moved to dead letter queue');
            _deadLetterQueue.addToQueue({ to: item.to, subject: item.subject, html: item.html, cc: item.cc, attachments: item.attachments, error: err.message, failedAt: new Date().toISOString() });
          }
        }
      }
    });
  }
}

function getConfig() {
  if (_config) return _config;

  // Fall back to environment variables
  const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  return {
    provider,
    smtp: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM
    },
    aws: {
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      from: process.env.AWS_SES_FROM
    },
    azure: {
      connectionString: process.env.AZURE_COMMUNICATION_CONNECTION_STRING,
      from: process.env.AZURE_EMAIL_FROM
    },
    brevo: {
      apiKey: process.env.BREVO_API_KEY,
      fromEmail: process.env.BREVO_FROM_EMAIL,
      fromName: process.env.BREVO_FROM_NAME || 'App'
    }
  };
}

function buildAttachments(attachments) {
  if (!attachments || !attachments.length) return [];
  return attachments.map(function(filePath) {
    return {
      filename: path.basename(filePath),
      content: fs.readFileSync(filePath)
    };
  });
}

async function sendViaSMTP(to, subject, html, cc, attachments) {
  var cfg = getConfig().smtp || {};
  var port = _num(cfg.port, 587);
  // 465 is implicit TLS from the first byte; 587 and 25 start in the clear and
  // negotiate STARTTLS. A hardcoded false made every 465 relay fail on the
  // handshake, so infer from the port unless it is stated.
  var secure = cfg.secure === undefined || cfg.secure === null ? port === 465 : !!cfg.secure;

  // Everything the caller set is forwarded; everything it did not is absent,
  // so nodemailer's defaults stand. Same shape as the email-send action's
  // connection object, so one SMTP server is described identically whether it
  // is configured on a workflow step or in this install's env.
  var transport = _compact({
    host: cfg.host,
    port: port,
    secure: secure,
    requireTLS: cfg.requireTLS,
    ignoreTLS: cfg.ignoreTLS,
    name: cfg.name,
    authMethod: cfg.authMethod,
    connectionTimeout: cfg.connectionTimeout,
    greetingTimeout: cfg.greetingTimeout,
    socketTimeout: cfg.socketTimeout,
    pool: cfg.pool,
    maxConnections: cfg.maxConnections,
    maxMessages: cfg.maxMessages,
    logger: cfg.debug ? undefined : false,
    debug: cfg.debug,
    tls: cfg.tls && Object.keys(cfg.tls).length ? cfg.tls : undefined
  });
  if (cfg.user || cfg.pass) transport.auth = _compact({ user: cfg.user, pass: cfg.pass });

  // Unrecognised options last, so a server that needs something this library
  // does not name is still reachable without editing this library. `tls` is
  // merged a level deeper instead of replaced — SMTP_TLS_* and a tls block in
  // SMTP_OPTIONS are both ways of saying the same thing, and dropping one
  // because the other was set would be a silent downgrade.
  if (cfg.options) {
    var extraTls = cfg.options.tls;
    Object.keys(cfg.options).forEach(function (k) {
      if (k !== 'tls') transport[k] = cfg.options[k];
    });
    if (extraTls) transport.tls = Object.assign({}, transport.tls, extraTls);
  }

  var transporter = loadNodemailer().createTransport(transport);

  var mailOptions = { from: cfg.from, to, subject, html };
  if (cc && cc.length) mailOptions.cc = cc;
  if (attachments && attachments.length) mailOptions.attachments = buildAttachments(attachments);

  try {
    await transporter.sendMail(mailOptions);
  } finally {
    // A pooled transport holds sockets open and would keep the process alive.
    if (typeof transporter.close === 'function') transporter.close();
  }
}

async function sendViaAWS(to, subject, html, cc, attachments) {
  var cfg = getConfig().aws;

  // If there are attachments or cc, use SESv2 with raw email via nodemailer
  if ((attachments && attachments.length) || (cc && cc.length)) {
    var { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    var transporter = loadNodemailer().createTransport({ streamTransport: true });

    var mailOptions = { from: cfg.from, to, subject, html };
    if (cc && cc.length) mailOptions.cc = cc;
    if (attachments && attachments.length) mailOptions.attachments = buildAttachments(attachments);

    var info = await transporter.sendMail(mailOptions);
    var rawMessage = await streamToBuffer(info.message);

    var client = new SESv2Client({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    });

    await client.send(new SendEmailCommand({
      Content: { Raw: { Data: rawMessage } }
    }));
    return;
  }

  var { SESClient, SendEmailCommand: SimpleSendCommand } = require('@aws-sdk/client-ses');

  var client = new SESClient({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
  });

  var command = new SimpleSendCommand({
    Source: cfg.from,
    Destination: { ToAddresses: to },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: html } }
    }
  });

  await client.send(command);
}

async function sendViaAzure(to, subject, html, cc, attachments) {
  var { EmailClient } = require('@azure/communication-email');
  var cfg = getConfig().azure;

  var message = {
    senderAddress: cfg.from,
    content: { subject, html },
    recipients: {
      to: to.map(function(addr) { return { address: addr }; })
    }
  };

  if (cc && cc.length) {
    message.recipients.cc = cc.map(function(addr) { return { address: addr }; });
  }

  if (attachments && attachments.length) {
    message.attachments = attachments.map(function(filePath) {
      return {
        name: path.basename(filePath),
        contentType: 'application/octet-stream',
        contentInBase64: fs.readFileSync(filePath).toString('base64')
      };
    });
  }

  var client = new EmailClient(cfg.connectionString);
  var poller = await client.beginSend(message);
  await poller.pollUntilDone();
}

async function sendViaBrevo(to, subject, html, cc, attachments) {
  var cfg = getConfig().brevo;

  var payload = {
    sender: { name: cfg.fromName, email: cfg.fromEmail },
    to: to.map(function(addr) { return { email: addr }; }),
    subject,
    htmlContent: html
  };

  if (cc && cc.length) {
    payload.cc = cc.map(function(addr) { return { email: addr }; });
  }

  if (attachments && attachments.length) {
    payload.attachment = attachments.map(function(filePath) {
      return {
        name: path.basename(filePath),
        content: fs.readFileSync(filePath).toString('base64')
      };
    });
  }

  var res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': cfg.apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    var err = await res.json();
    throw new Error('Brevo email failed: ' + (err.message || JSON.stringify(err)));
  }
}

/**
 * Send an email directly (no queue).
 */
async function _sendDirect(to, subject, html, cc, attachments) {
  to = Array.isArray(to) ? to : [to];
  var provider = getConfig().provider;

  switch (provider) {
    case 'smtp':
      return sendViaSMTP(to, subject, html, cc, attachments);
    case 'aws':
      return sendViaAWS(to, subject, html, cc, attachments);
    case 'azure':
      return sendViaAzure(to, subject, html, cc, attachments);
    case 'brevo':
      return sendViaBrevo(to, subject, html, cc, attachments);
    default:
      throw new Error('Unknown email provider: ' + provider);
  }
}

/**
 * Send an email. If useQueue is enabled, queues with retry. Otherwise sends directly.
 * @param {string|string[]} to - Recipient emails
 * @param {string} subject - Email subject
 * @param {string} html - HTML body
 * @param {string[]} [cc] - CC recipients
 * @param {string[]} [attachments] - File paths to attach
 */
async function sendEmail(to, subject, html, cc, attachments) {
  if (_queue) {
    _queue.addToQueue({ to: Array.isArray(to) ? to : [to], subject, html, cc, attachments, _retries: 0 });
    return;
  }
  return _sendDirect(to, subject, html, cc, attachments);
}

function streamToBuffer(stream) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    stream.on('data', function(chunk) { chunks.push(chunk); });
    stream.on('end', function() { resolve(Buffer.concat(chunks)); });
    stream.on('error', reject);
  });
}

/**
 * Get the dead letter queue (failed emails after max retries).
 * Returns null if queue is not enabled.
 */
function getDeadLetterQueue() {
  return _deadLetterQueue;
}

/**
 * Replay all dead letter emails back through the main queue.
 * Drains the dead letter queue and re-sends each item.
 * @returns {Promise<number>} Number of emails replayed
 */
async function replayDeadLetters() {
  if (!_deadLetterQueue) return 0;
  var items = await _deadLetterQueue.drain();
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    await sendEmail(item.to, item.subject, item.html, item.cc, item.attachments);
  }
  return items.length;
}

// ── SMTP from env ───────────────────────────────────────────────────────
//
// The same knobs the email-send ACTION already exposes on its connection
// object (see @xeplr/actions lib/drivers/email/smtp.js), read from env instead
// of from a workflow step. Kept deliberately open-ended rather than curated
// per provider: "which SMTP server is this" is not a question this library can
// answer, and every provider-specific list eventually meets a server that
// needs one more option. Anything left unset is left OUT of the transport, so
// nodemailer's own defaults apply.

function _num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

function _bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  var t = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(t) !== -1) return true;
  if (['0', 'false', 'no', 'off'].indexOf(t) !== -1) return false;
  return fallback;
}

function _compact(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

function smtpFromEnv() {
  var env = process.env;

  var tls = _compact({
    rejectUnauthorized: _bool(env.SMTP_TLS_REJECT_UNAUTHORIZED, undefined),
    servername: env.SMTP_TLS_SERVERNAME || undefined
  });

  return _compact({
    host: env.SMTP_HOST,
    port: _num(env.SMTP_PORT, 587),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
    // Undefined unless stated, so sendViaSMTP infers it from the port.
    secure: _bool(env.SMTP_SECURE, undefined),
    requireTLS: _bool(env.SMTP_REQUIRE_TLS, undefined),
    ignoreTLS: _bool(env.SMTP_IGNORE_TLS, undefined),
    name: env.SMTP_NAME || undefined,             // EHLO/HELO — some servers are picky
    authMethod: env.SMTP_AUTH_METHOD || undefined,
    connectionTimeout: _num(env.SMTP_CONNECTION_TIMEOUT, undefined),
    greetingTimeout: _num(env.SMTP_GREETING_TIMEOUT, undefined),
    socketTimeout: _num(env.SMTP_SOCKET_TIMEOUT, undefined),
    pool: _bool(env.SMTP_POOL, undefined),
    maxConnections: _num(env.SMTP_MAX_CONNECTIONS, undefined),
    maxMessages: _num(env.SMTP_MAX_MESSAGES, undefined),
    debug: _bool(env.SMTP_DEBUG, undefined),
    tls: Object.keys(tls).length ? tls : undefined,
    // THE ESCAPE HATCH. Named options cover the common ground; this carries
    // anything a particular server needs that this library has never heard of
    // (dkim, proxy, tls.ciphers, a vendor's own flag). Merged last, so it can
    // also override any of the above.
    options: _smtpOptionsFromEnv(env.SMTP_OPTIONS)
  });
}

// Invalid JSON THROWS rather than being skipped. A typo here would otherwise
// drop the one option the server actually needed and fail later as a refused
// connection or, worse, an unencrypted send that looked fine.
function _smtpOptionsFromEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('SMTP_OPTIONS is not valid JSON: ' + err.message +
      ' — expected a JSON object, e.g. {"dkim":{"domainName":"x.com"}}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SMTP_OPTIONS must be a JSON OBJECT of nodemailer transport options, got ' +
      (Array.isArray(parsed) ? 'an array' : typeof parsed) + '.');
  }
  return parsed;
}

// Build an email config from env (EMAIL_PROVIDER + provider vars). Pure — returns
// the config or null if no provider is set. The single source for env→email config.
function emailConfigFromEnv() {
  var provider = process.env.EMAIL_PROVIDER;
  if (!provider) return null;

  var config = { provider: provider };
  if (provider === 'brevo') {
    config.brevo = {
      apiKey: process.env.BREVO_API_KEY,
      fromEmail: process.env.BREVO_FROM_EMAIL,
      fromName: process.env.BREVO_FROM_NAME
    };
  } else if (provider === 'smtp') {
    config.smtp = smtpFromEnv();
  }
  // aws / azure read their own vars here when those providers are used.
  return config;
}

// Configure the email sender straight from env. Returns true if a provider was set.
function configureFromEnv() {
  var config = emailConfigFromEnv();
  if (!config) return false;
  configureEmail(config);
  return true;
}

module.exports = { sendEmail, configureEmail, emailConfigFromEnv, smtpFromEnv, configureFromEnv, getDeadLetterQueue, replayDeadLetters };
