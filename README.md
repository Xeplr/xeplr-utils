# @xeplr/utils

**The shared server-side building blocks of xeplr apps**: sending email (SMTP, Brevo, AWS SES, Azure), a Redis cache, in-process queues, a fixed JSON response shape, rate limiting, file uploads, SMS and OTP, a client for the xeplr logs service, and the classification of SQL errors into "retry" and "don't". Plus an `isomorphic` part — status codes, messages, crypto, email normalisation — that runs in the browser as well as in Node.

Nothing here needs Redis, nodemailer or multer until you use the feature that needs it. Each is an optional peer dependency, loaded on first use.

## Install

```sh
npm i @xeplr/utils
```

Uses the global `fetch` (Node 18 or later). Then install the peers for the features you use:

| feature | peer to install |
|---|---|
| `cache`, `otp`, `Queue` / `RateLimiter` with `store: 'redis'`, the email queue with `store: 'redis'` | `ioredis` |
| email, `provider: 'smtp'` (and `checkEmail` for smtp) | `nodemailer` |
| email, `provider: 'aws'` | `@aws-sdk/client-ses`; for a message with cc or attachments also `@aws-sdk/client-sesv2` and `nodemailer` |
| email, `provider: 'azure'` | `@azure/communication-email` |
| email, `provider: 'brevo'` | nothing — plain HTTPS |
| `FileUploader` | `multer` |
| `sms`, logger client, `respond`, helpers, `isomorphic` | nothing |

A missing `ioredis`, `nodemailer` or `multer` throws an error that names the package to install, not a bare `Cannot find module`. (`@aws-sdk/*` and `@azure/communication-email` are required directly, so for those you get Node's own error.)

## What you can require

```js
var utils = require('@xeplr/utils')
```

| export | from | what |
|---|---|---|
| `sendEmail`, `configureEmail`, `configureFromEnv`, `emailConfigFromEnv`, `smtpFromEnv`, `checkEmail` | `lib/email` | [Email](#email) |
| `configureLogger`, `createSession`, `log`, `closeSession`, `getSessionLogs` | `lib/logger` | [Logger client](#logger-client) |
| `generateId`, `formatDbDateTime`, `mysqlDateTime` | `lib/helpers` | [Helpers](#helpers) |
| `respond`, `sanitizeError` | `lib/response` | [Responses](#responses) |
| `cache` | `lib/cache` | [Cache](#cache) |
| `Queue` (with `Queue.SqlQueue`) | `lib/queue` | [Queue](#queue) |
| `classifySqlError`, `isRetryableSqlError` | `lib/sql-error` | [SQL errors](#sql-errors) |
| `FileUploader` | `lib/fileUploader` | [File uploads](#file-uploads) |
| `RateLimiter` | `lib/rateLimiter` | [Rate limiting](#rate-limiting) |
| `sms` | `lib/sms` | [SMS](#sms) |
| `otp` | `lib/otp` | [OTP](#otp) |

Subpaths, from the package's `exports` map — these and no others:

| subpath | |
|---|---|
| `@xeplr/utils/isomorphic` | [Isomorphic](#isomorphic) — browser and Node |
| `@xeplr/utils/isomorphic/crypto` | `encrypt`, `decrypt`, `encryptSplit`, `decryptSplit` |
| `@xeplr/utils/isomorphic/countries` | `COUNTRIES` |
| `@xeplr/utils/isomorphic/states` | `STATES`, `STATES_IN` |
| `@xeplr/utils/lib/cache` | same object as `utils.cache` |
| `@xeplr/utils/lib/email` | the email exports above, plus `getDeadLetterQueue` and `replayDeadLetters` (not on the root) |
| `@xeplr/utils/lib/fileUploader` | `FileUploader` |
| `@xeplr/utils/lib/helpers` | `generateId`, `formatDbDateTime`, `mysqlDateTime` |
| `@xeplr/utils/lib/logger` | the logger client |
| `@xeplr/utils/lib/otp` | `configureOtp`, `requestOtp`, `verifyOtp` |
| `@xeplr/utils/lib/queue` | `Queue` (also `.Queue`, `.SqlQueue`, `.classifySqlError`) |
| `@xeplr/utils/lib/rateLimiter` | `RateLimiter` |
| `@xeplr/utils/lib/response` | `respond`, `sanitizeError` |
| `@xeplr/utils/lib/sms` | `register`, `setDefault`, `send`, `getProviders` |

`lib/sql-error` has no subpath: take `classifySqlError` from the root or from `lib/queue`.

## Cache

Redis, through `ioredis`. JSON values with a TTL.

```js
var { cache } = require('@xeplr/utils')

cache.configureCache({ keyPrefix: 'myapp:' })        // optional — env is read without it

await cache.set('access:user:42', { roles: ['admin'] }, 600)   // TTL in seconds; default 300
await cache.get('access:user:42')                   // the value, or null
await cache.del('access:user:42')
await cache.delPattern('access:user:*')             // SCAN + DEL, never KEYS
await cache.disconnectCache()                       // on shutdown
```

| variable | default |
|---|---|
| `REDIS_HOST` | `127.0.0.1` |
| `REDIS_PORT` | `6379` |
| `REDIS_PASSWORD` | none |
| `REDIS_DB` | `0` |
| `REDIS_PREFIX` | `xeplr:` |

`configureCache(config)` takes `host`, `port`, `password`, `db`, `keyPrefix`, `defaultTTL` (300), `maxRetriesPerRequest` (3), `enableOfflineQueue` (true), `lazyConnect` (true); anything not given comes from the variables above. Calling it again disconnects the current client. The client is created, and connects, on first use — requiring the module opens nothing. It reconnects with backoff (up to 3 s apart) and gives up after 10 attempts.

### Every app sets its own `REDIS_PREFIX`

**Every key is written under a prefix: `config.keyPrefix`, else `REDIS_PREFIX`, else `xeplr:`.** Set `REDIS_PREFIX` for each app (`REDIS_PREFIX=myapp:`).

Why: apps that share one Redis and all keep the default write into the same `xeplr:` namespace, so each reads — and `delPattern` deletes — the others' keys. A cached permission set from one app is then served by another. `@xeplr/auth` therefore requires `REDIS_PREFIX` and refuses `xeplr:`.

The prefix applies to everything that goes through this client, not only `cache.get/set`: the Redis stores of `Queue` and `RateLimiter`, the email queue, and `otp` all use it.

`delPattern(pattern)` matches under the prefix the client really uses, wherever it came from. Before 1.0.11 it used only `configureCache`'s `keyPrefix`, so when the prefix came from `REDIS_PREFIX` or the default, pattern deletes matched nothing and silently did nothing.

### Cache failures never throw

`get`, `set`, `del` and `delPattern` swallow every error: Redis down, a timeout, bad JSON — even `ioredis` not being installed. `get` then returns `null`; the others return as if they had worked. The cache is treated as optional: a request falls through to the database rather than failing. The cost is that a misconfigured cache is invisible — check Redis separately if you depend on it (see `otp` below). `disconnectCache()` and `getClient()` (the raw `ioredis` client) do throw.

## Email

One `sendEmail` for four providers.

```js
var { configureFromEnv, sendEmail } = require('@xeplr/utils')

configureFromEnv()     // true if EMAIL_PROVIDER is set
await sendEmail(['a@x.com'], 'Welcome', '<p>Hello</p>', ['cc@x.com'], ['/tmp/invoice.pdf'])
```

`sendEmail(to, subject, html, cc?, attachments?)` — `to` a string or an array, `cc` an array, `attachments` an array of **file paths** (read from disk, named by their basename). Without a queue it resolves when the provider accepted the message and throws when it did not.

### Configuring

| call | does |
|---|---|
| `configureEmail(config)` | `{ provider: 'smtp' \| 'brevo' \| 'aws' \| 'azure', smtp?, brevo?, aws?, azure?, useQueue?, … }` |
| `configureFromEnv()` | `configureEmail(emailConfigFromEnv())`; returns `false` and changes nothing when `EMAIL_PROVIDER` is unset |
| `emailConfigFromEnv()` | builds that config from env without applying it; `null` when `EMAIL_PROVIDER` is unset |
| `smtpFromEnv()` | just the `smtp` block, from the `SMTP_*` variables |

Without any configure call, a send reads env on each send (`EMAIL_PROVIDER` defaulting to `smtp`), but only the basic variables: `SMTP_HOST/PORT/USER/PASS/FROM`, the `AWS_*`, `AZURE_*` and `BREVO_*` ones — not `SMTP_SECURE`, `SMTP_OPTIONS` or the other extended SMTP settings.

**`emailConfigFromEnv` / `configureFromEnv` fill in the `smtp` and `brevo` blocks only.** For `aws` or `azure`, pass the block to `configureEmail` yourself — a config set with `configureFromEnv` and `EMAIL_PROVIDER=aws` has no `aws` block, and the send fails.

```js
configureEmail({ provider: 'aws', aws: { region, accessKeyId, secretAccessKey, from } })
```

Write `EMAIL_PROVIDER` in lower case: `emailConfigFromEnv` compares it exactly.

### SMTP

| variable | |
|---|---|
| `SMTP_HOST` | required |
| `SMTP_PORT` | `587` |
| `SMTP_USER`, `SMTP_PASS` | auth; omitted when neither is set |
| `SMTP_FROM` | the From address — required |
| `SMTP_SECURE` | implicit TLS. Unset: `true` on port 465, else `false` (STARTTLS) |
| `SMTP_REQUIRE_TLS`, `SMTP_IGNORE_TLS` | |
| `SMTP_TLS_REJECT_UNAUTHORIZED`, `SMTP_TLS_SERVERNAME` | into `tls` |
| `SMTP_NAME` | EHLO/HELO name |
| `SMTP_AUTH_METHOD` | |
| `SMTP_CONNECTION_TIMEOUT`, `SMTP_GREETING_TIMEOUT`, `SMTP_SOCKET_TIMEOUT` | milliseconds |
| `SMTP_POOL`, `SMTP_MAX_CONNECTIONS`, `SMTP_MAX_MESSAGES` | |
| `SMTP_DEBUG` | nodemailer debug logging |
| `SMTP_OPTIONS` | JSON object of any other nodemailer transport options |

Booleans accept `1/true/yes/on` and `0/false/no/off`. **A setting left unset is left out of the transport**, so nodemailer's own default applies rather than one this library picked.

`SMTP_OPTIONS` is the escape hatch for what a particular server needs and the list above does not name (`dkim`, `proxy`, `tls.ciphers`). It is merged last, so it overrides the named settings; its `tls` is merged into the `tls` from `SMTP_TLS_*` instead of replacing it. **Invalid JSON, or JSON that is not an object, throws** — a typo that silently dropped the one option the server needed would show up later as a refused connection, or as an unencrypted send that looked fine.

```sh
SMTP_OPTIONS='{"dkim":{"domainName":"example.com","keySelector":"s1","privateKey":"..."}}'
```

### Brevo, AWS SES, Azure

| provider | variables |
|---|---|
| `brevo` | `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` |
| `aws` | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SES_FROM` |
| `azure` | `AZURE_COMMUNICATION_CONNECTION_STRING`, `AZURE_EMAIL_FROM` |

`aws` sends through SES `SendEmail`; a message with cc or attachments is built as a raw MIME message by nodemailer and sent through SES v2. `azure` waits for the send operation to complete.

### Checking email at startup: `checkEmail`

```js
var r = await checkEmail({ timeoutMs: 5000 })   // { ok, provider, detail }
// { ok: true,  provider: 'smtp', detail: 'smtp.example.com:587, connected' }
// { ok: false, provider: null,   detail: 'not configured (EMAIL_PROVIDER is not set)' }
```

Can this process send email? **Never throws, never sends a message.** It checks the config given to `configureEmail`, else the one `emailConfigFromEnv` builds.

| provider | checks |
|---|---|
| `smtp` | `SMTP_HOST` and `SMTP_FROM` set, then connects and authenticates (nodemailer `verify`) **with the same transport options a real send uses**, `SMTP_OPTIONS` included — so a passing check means the same connection a send makes. Gives up after `timeoutMs` (default 5000) rather than hanging startup |
| `brevo` | key and from address set, then asks Brevo's `/v3/account` whether the API key is accepted |
| `aws`, `azure` | the settings are present; the service is not contacted |

`detail` names the missing setting or the failure (`SMTP_HOST is not set`, `nodemailer is not installed (npm install nodemailer)`, `Brevo refused the API key (401)`). `@xeplr/auth` prints it in its startup banner.

### Queue, retries, dead letters

```js
configureEmail({
  provider: 'smtp', smtp: smtpFromEnv(),
  useQueue: true,
  maxRetries: 3,                   // attempts per message
  retryIntervalInSeconds: 60,      // how often the queue is processed
  store: 'redis',                  // or 'memory' (default)
  redisKey: 'xeplr:queue:email',   // default; stored under the cache prefix
  deadLetterKey: 'xeplr:queue:email:dead'
})
```

With `useQueue`, `sendEmail` only enqueues and resolves at once — a failure never reaches the caller; it is logged with `console.error`. The queue is processed every `retryIntervalInSeconds`. A failed send is put back on the queue with its attempt count; after `maxRetries` attempts the message goes to the dead-letter queue with `error` and `failedAt`.

Note: a message put back is picked up again in the same pass, so its retries follow each other immediately rather than `retryIntervalInSeconds` apart. The interval delays the first attempt, not the retries.

With `store: 'memory'` queued and dead messages are lost on restart; `'redis'` keeps them. Attachments are stored as paths, so the files must still exist when the message is sent.

```js
var { getDeadLetterQueue, replayDeadLetters } = require('@xeplr/utils/lib/email')

await getDeadLetterQueue().list()     // what failed
await replayDeadLetters()             // drains it and sends each again; returns the count
```

## Responses

Every xeplr API answers in one shape, so the UI reads every response the same way.

```js
var { respond } = require('@xeplr/utils')
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic')

respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: orders })
respond(res, HTTP.OK, STATUS.UPDATED, 'updated', { updatedIds: [id] })
respond(res, HTTP.BAD_REQUEST, STATUS.BAD_REQUEST, 'bad_request', { error: err })
```

```json
{ "code": "SUCCESS", "message": "Success", "error": null, "dataArray": [], "updatedIds": [], "sessionId": null }
```

`respond(res, httpCode, statusCode, messageKey, options?)`:

| field | from |
|---|---|
| `code` | `statusCode` |
| `message` | `options.message`, else `msg(messageKey)` in the current language (the key itself if it is not in `MESSAGES`) |
| `error` | `sanitizeError(options.error)` — `{ name, message, ...own properties }`, **never the stack**; `null` without one |
| `dataArray` | `options.dataArray`, else `[]` |
| `updatedIds` | `options.updatedIds`, else `[]` |
| `sessionId` | `req.sessionId`, else `null` |
| `pagination` | `options.pagination`, only when given |

It calls `res.status(httpCode).send(body)` — an Express response.

## Helpers

| | |
|---|---|
| `generateId()` | 24 random hex characters (12 bytes from `crypto.randomBytes`) |
| `formatDbDateTime(date?)` | `date.toISOString()`, now without a date |
| `mysqlDateTime` | the same function, kept for old callers |

## Queue

A small in-process queue that hands each item to an `action`.

```js
var { Queue } = require('@xeplr/utils')

var q = new Queue({
  action: async (item) => { await deliver(item) },
  autoIntervalInSeconds: 10,   // process every 10 s; 0 = only when you call flushQueue()
  maxEmptyTicks: 6,            // pause after 6 empty ticks; 0 = never
  store: 'memory',             // or 'redis' (ioredis; list at redisKey, under the cache prefix)
  redisKey: 'myapp:jobs'       // default 'xeplr:queue:default'
})

q.addToQueue({ id: 1 })        // resumes a paused queue
await q.flushQueue()           // process everything now, one at a time
await q.list(); await q.clear(); await q.drain()   // drain removes and returns all items
q.pause(); q.resume(); q.stop()
```

**Catch errors inside `action`.** One that throws ends the pass with the item already removed; on an `autoIntervalInSeconds` tick the rejection is unhandled (by default Node exits) and no further tick is scheduled, so the queue stops. Timers are `unref`'d, so a queue never keeps the process alive.

### SqlQueue

`Queue.SqlQueue` is a separate in-memory worker pool for executing SQL, used by the data-movement uploader. Every item belongs to a `movementId`; `abort(movementId)` drops that movement's queued items without touching others.

```js
var { SqlQueue } = require('@xeplr/utils').Queue

var sq = new SqlQueue({
  executor: async (item, conn) => { /* run item.sql on conn */ },
  connections: { target: encryptedString },   // or a plain config object
  encryptionKey: process.env.ENCRYPTION_KEY,   // decrypts string connections (isomorphic/crypto)
  concurrency: 4, maxAttempts: 3, retryDelaysMs: [5000, 15000, 45000],
  maxConsecutiveDrops: 5, maxMemoryMB: 200,
  onErrorTable: ({ item, error, rowNum, reason, errorCode, errorKind, attempts }) => {},
  onMovementAbort: ({ movementId, reason }) => {}
})

await sq.addToQueue({ movementId, connection: 'target', meta: { rows, rowCount: rows.length, rowsToSql } })
await sq.drain()
sq.stats(movementId)   // { queued, inFlight, completed, dropped, statements, statementsDropped, aborted, … }
```

- `addToQueue` waits while queued items exceed `maxMemoryMB`, and continues below 75% of it.
- On a failure, `errorExecutor` (optional) decides `retry`, `bisect` (split `meta.rows` in half and queue both), `error-table`, `drop` or `fatal` (abort the movement). `maxConsecutiveDrops` drops in a row also abort it.
- The default decision: a **deterministic** error ([SQL errors](#sql-errors)) bisects, or goes to the error table, straight away; anything else is retried with `retryDelaysMs` and bisected on the last attempt. Why: a NOT NULL violation fails the same way every time, and waiting out the backoff before accepting that cost 105 seconds on a 1000-row movement.
- `completed` and `dropped` count **rows** (`meta.rowCount`, 1 without it); `statements` / `statementsDropped` count statements.

## SQL errors

Should the same statement be sent again?

```js
var { classifySqlError, isRetryableSqlError } = require('@xeplr/utils')

classifySqlError(err)   // { retryable, kind: 'transient' | 'deterministic' | 'unknown', code, dialect }
```

One function covers Postgres, MySQL and SQL Server, because each driver's native error identifies itself:

| dialect | read from | deterministic (not retryable) | transient |
|---|---|---|---|
| postgres | `err.code`, the SQLSTATE class | `22` data, `23` constraint, `42` syntax / no such column, `3F`, `0A` | `08` connection, `40` deadlock / serialization, `53` resources, `57`, `58` |
| mysql | `err.errno` (and client codes like `PROTOCOL_CONNECTION_LOST`) | null, duplicate, bad value, unknown column / table, foreign key … | too many connections, lock wait, deadlock, server gone away … |
| mssql | `err.number` | 515, 547, 2601, 2627, 245, 8152 … | 1205 deadlock, 1222, Azure 40501 / 40613 … |
| any | Node socket codes | | `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, … |

**Anything not recognised is `unknown` and retryable.** Wrongly retrying a deterministic error costs time; wrongly dropping a transient one loses rows. `code` is the database's own identifier as a string, for log lines.

## File uploads

Multer disk storage behind an auth check, as Express middleware.

```js
var { FileUploader } = require('@xeplr/utils')

var uploader = new FileUploader({
  auth: async (req) => Boolean(req.user),        // falsy or a throw → 401
  allowedTypes: ['image/*', 'application/pdf'],  // default ['*']
  maxSize: 5 * 1024 * 1024,                      // bytes; default 5 MB
  destination: './uploads'                       // else UPLOAD_DIR, else ./uploads
})

app.post('/upload', uploader.single('file'), (req, res) => res.json(req.file))
// uploader.array('files', 10), uploader.fields([{ name: 'avatar', maxCount: 1 }])
```

The destination is created when the uploader is. Files are saved as `generateId()` plus the original extension — never the uploaded name. Errors answer JSON: 401 unauthorised, 413 `File too large`, 400 `File type not allowed: <type>`, 500 otherwise.

## Rate limiting

```js
var { RateLimiter } = require('@xeplr/utils')

app.use('/auth/login', new RateLimiter({
  windowInSeconds: 60, max: 10,
  store: 'redis',                    // or 'memory' (default) — per process
  keyFn: (req) => req.ip,            // default
  message: 'Too many attempts'
}).middleware())
```

Fixed window per key. Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; over the limit it answers 429 `{ error: message }` with `Retry-After`. The Redis store keys are `xeplr:ratelimit:<key>` under the cache prefix. **If the limiter itself fails (Redis down), the request is let through** — a broken limiter must not take the API down.

## SMS

A registry of HTTP-API providers described as data — no provider SDKs.

```js
var { sms } = require('@xeplr/utils')

sms.register('twilio', {
  params: { accountSid: 'AC…', authToken: '…', from: '+15550000000' },
  actions: {
    send: {
      url: 'https://api.twilio.com/2010-04-01/Accounts/{{accountSid}}/Messages.json',
      method: 'POST', contentType: 'form',
      auth: { user: '{{accountSid}}', password: '{{authToken}}' },
      body: { From: '{{from}}', To: '{{to}}', Body: '{{message}}' }
    }
  }
})
sms.setDefault('twilio')

await sms.send({ to: '+91…', message: 'Hello' })              // default provider, action 'send'
await sms.send('twilio', { to: '+91…', message: 'Hello' })    // action 'send'
await sms.send('kaleyra', 'otp', { to: '+91…', message: '…' }) // a named action
```

- `{{name}}` placeholders in `url`, `headers`, `auth` and `body` come from the provider's `params` merged with the send's.
- `contentType`: `json` (default) or `form`. `auth` is HTTP Basic.
- `before: ['auth']` runs other actions first; their `extract: { token: 'data.token' }` copies values from the response into the params — for providers that issue a token per session.
- Returns `{ success, messageId, raw }` or `{ success: false, error, raw }`; `parseResponse(raw, result)` on the provider replaces that. An unknown provider or action throws.

## OTP

Short-lived codes in Redis, delivered through `sms`.

```js
var { otp } = require('@xeplr/utils')

otp.configureOtp({ provider: 'twilio', codeLength: 6, ttlSeconds: 300, maxAttempts: 5,
  message: (code) => 'Your code is ' + code })

await otp.requestOtp('+91…')             // { sent: true }; throws if the SMS failed
await otp.verifyOtp('+91…', '482913')    // { success: true } | { success: false, reason: 'expired' | 'invalid' | 'too_many_attempts' }
```

The code is stored at `otp:<identifier>` (under the cache prefix) with the TTL as its expiry — no table, no cleanup job. Codes are generated with `crypto.randomInt` and are single-use. `maxAttempts` wrong guesses delete the code; a wrong guess resets the TTL, so the real limit is the attempt count, not the time. Without `provider`, the `sms` default is used.

Because [cache errors are swallowed](#cache-failures-never-throw), with Redis unreachable `requestOtp` still sends the SMS and every `verifyOtp` answers `expired`.

## Logger client

Talks to the xeplr logs service over HTTP.

```js
var { configureLogger, createSession, log, closeSession, getSessionLogs } = require('@xeplr/utils')

configureLogger({ url: 'http://logs:19005' })       // else LOGS_URL, else http://localhost:19005
await createSession({ source: 'importer', action: 'nightly' })   // the service's JSON reply
await log(sessionId, 'info', 'Loaded 1200 rows', { table: 'orders' })
await closeSession(sessionId)
await getSessionLogs(sessionId)
```

`POST /internal/sessions`, `POST /internal/logs`, `POST /internal/sessions/:id/close`, `GET /internal/sessions/:id`. Each returns the service's JSON and **throws** on a non-2xx answer — catch it if logging must not break the work being logged.

## Isomorphic

`@xeplr/utils/isomorphic` runs in the browser (bundled) and in Node — no `fs`, no Node `crypto` except as a fallback where Web Crypto is missing.

```js
import { HTTP, STATUS, msg, readResponse, normalizeEmail } from '@xeplr/utils/isomorphic'
```

| export | |
|---|---|
| `HTTP` | `OK` 200, `CREATED` 201, `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `VALIDATION_ERROR` 422, `TOO_MANY_REQUESTS` 429, `SERVER_ERROR` 500, `SERVICE_UNAVAILABLE` 503 |
| `STATUS` | application codes: `SUCCESS`, `CREATED`, `UPDATED`, `DELETED`, the error names matching `HTTP`, and auth codes (`LOGIN_SUCCESS`, `LOGIN_FAILED`, `INVALID_TOKEN`, …) |
| `MESSAGES`, `msg(key, lang?)` | message strings in `en` and `fr`; `msg` falls back to `en`, then to the key |
| `configureLang(lang)`, `getLang()` | language: `configureLang`, else `APP_LANG`, else `window.__APP_LANG__`, else `en` |
| `readResponse(body)` | reads the [response shape](#responses): `{ code, message, error, dataArray, updatedIds, ok, hasError, hasData, hasUpdates, first, is(status) }` |
| `normalizeEmail(email)`, `isDotInsensitive(domain)` | lower-cases; for `gmail.com` and `googlemail.com` also removes dots and `+alias` from the local part, so `j.doe+x@gmail.com` and `jdoe@gmail.com` are one user |
| `encrypt`, `decrypt` | see below |
| `formatDbDateTime`, `mysqlDateTime`, `formatDate`, `formatDateTime`, `deepClone`, `isEmpty` | `formatDate` → `15 Mar 2026` (`en-GB` default) |
| `COUNTRIES`, `STATES`, `STATES_IN` | `[{ code, name }]` — ISO countries; states of India (`STATES.IN`) |

### Crypto

AES-256-GCM with a key derived from a passphrase (PBKDF2, SHA-256, 100 000 iterations), using Web Crypto.

```js
var { encrypt, decrypt } = require('@xeplr/utils/isomorphic/crypto')

var blob = await encrypt(JSON.stringify({ host, port, user, password }), process.env.ENCRYPTION_KEY)
var config = JSON.parse(await decrypt(blob, process.env.ENCRYPTION_KEY))
```

`encrypt` returns base64 of salt (16 bytes) + IV (12) + ciphertext; a fresh salt and IV each time, so the same text never encrypts the same way twice. This is the format of xeplr's **encrypted database connection strings**: `@xeplr/db` (`xeplr-db-encrypt`) writes them and decrypts them with `ENCRYPTION_KEY`, and `SqlQueue` decrypts string `connections` the same way. `decrypt` throws on a wrong key or a changed payload.

`encryptSplit(text, key, salt?)` → `{ salt, ciphertext }` and `decryptSplit(ciphertext, key, salt)` keep the salt out of the payload, for storing it separately. `encryptSplit` and `decryptSplit` are only on the `isomorphic/crypto` subpath.

## Tests

```sh
npm test
```

`node --test` over `test/*.test.js`:

- **cache** — `delPattern` against a local Redis (`REDIS_HOST`/`REDIS_PORT`, a per-run `REDIS_PREFIX`); skipped, and reported as skipped, when no Redis answers.
- **email** — `checkEmail` and a real send against fake SMTP servers started in the test (one that answers, one that never does); Brevo with `fetch` stubbed, AWS and Azure without contacting them.
- **SQL** — `classifySqlError` for each dialect, and `SqlQueue`'s retry, bisect, backpressure, abort and encrypted connections.

## License

MIT
