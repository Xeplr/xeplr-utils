// FileUploader's destination as a function: asked per upload, so each lands
// where that request belongs. A real server and a real multipart upload.
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');
var express = require('express');
var { FileUploader } = require('../index');

var root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dest-')));

function serve(uploader) {
  var app = express();
  app.post('/up', uploader.single('file'), function(req, res) { res.json({ path: req.file.path }); });
  return new Promise(function(resolve) {
    var server = app.listen(0, function() { resolve(server); });
  });
}

async function send(server, company) {
  var form = new FormData();
  form.append('file', new Blob(['a,b\n1,2\n']), 'rows.csv');
  var res = await fetch('http://127.0.0.1:' + server.address().port + '/up', { method: 'POST', body: form, headers: company ? { 'x-company': company } : {} });
  return { status: res.status, body: await res.json() };
}

test('each upload lands in the folder the function names for its request, made if missing', async function() {
  var uploader = new FileUploader({ destination: function(req) { return path.join(root, req.get('x-company'), 'uploads'); } });
  var server = await serve(uploader);
  try {
    var a = await send(server, 'acme');
    var b = await send(server, 'beta');
    assert.equal(a.status, 200);
    assert.equal(path.dirname(a.body.path), path.join(root, 'acme', 'uploads'));
    assert.equal(path.dirname(b.body.path), path.join(root, 'beta', 'uploads'));
    assert.equal(fs.readFileSync(a.body.path, 'utf8'), 'a,b\n1,2\n');
    assert.notEqual(path.basename(a.body.path), 'rows.csv', 'never the uploaded name');
  } finally { server.close(); }
});

test('a function that refuses refuses the upload, with its own 4xx status; nothing is written', async function() {
  var uploader = new FileUploader({ destination: async function(req) {
    if (!req.get('x-company')) { var err = new Error('This work runs as no tenant'); err.status = 400; throw err; }
    return path.join(root, req.get('x-company'));
  } });
  var server = await serve(uploader);
  try {
    var none = await send(server, null);
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no tenant/);
  } finally { server.close(); }
});

test('no folder named: the requesting tenant\'s own uploads/, never a shared one; no tenant is refused', async function() {
  // @xeplr/db's tenancy (its entry also opens connections, which needs this package).
  var db = require('@xeplr/db/lib/BaseModel');
  var data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fu-data-')));
  process.env.XEPLR_DATA_DIR = data;
  db.registerApplication('utils-test');
  db.registerMTs({ l1: { name: 'companyId', header: 'x-company' } });
  var app = express();
  app.use(db.mtMiddleware());
  app.post('/up', new FileUploader().single('file'), function(req, res) { res.json({ path: req.file.path }); });
  var server = await new Promise(function(resolve) { var s = app.listen(0, function() { resolve(s); }); });
  try {
    var a = await send(server, 'acme');
    assert.equal(path.dirname(a.body.path), path.join(data, 'utils-test', 'acme', 'uploads'));
    var none = await send(server, null);
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no tenant/);
  } finally { server.close(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a fixed folder still works as before', async function() {
  var dir = path.join(root, 'fixed');
  var server = await serve(new FileUploader({ destination: dir }));
  try {
    var r = await send(server, null);
    assert.equal(path.dirname(r.body.path), dir);
  } finally { server.close(); }
});
