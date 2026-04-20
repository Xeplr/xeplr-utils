const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

let _config = null;
let _queue = null;
let _deadLetterQueue = null;

/**
 * Configure the email service.
 * @param {object} config
 * @param {string} config.provider - 'smtp' | 'aws' | 'azure' | 'brevo'
 * @param {object} [config.smtp] - { host, port, user, pass, from }
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
  var cfg = getConfig().smtp;
  var transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: false,
    auth: { user: cfg.user, pass: cfg.pass }
  });

  var mailOptions = { from: cfg.from, to, subject, html };
  if (cc && cc.length) mailOptions.cc = cc;
  if (attachments && attachments.length) mailOptions.attachments = buildAttachments(attachments);

  await transporter.sendMail(mailOptions);
}

async function sendViaAWS(to, subject, html, cc, attachments) {
  var cfg = getConfig().aws;

  // If there are attachments or cc, use SESv2 with raw email via nodemailer
  if ((attachments && attachments.length) || (cc && cc.length)) {
    var { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    var transporter = nodemailer.createTransport({ streamTransport: true });

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

module.exports = { sendEmail, configureEmail, getDeadLetterQueue, replayDeadLetters };
