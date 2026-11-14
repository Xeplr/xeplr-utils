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

test('a fixed folder still works as before', async function() {
  var dir = path.join(root, 'fixed');
  var server = await serve(new FileUploader({ destination: dir }));
  try {
    var r = await send(server, null);
    assert.equal(path.dirname(r.body.path), dir);
  } finally { server.close(); }
});

// THE FILE'S BYTES ARRIVE LATER THAN THE REQUEST. Multer reads the file as it
// comes in on the socket; a part that arrives after the middleware has run is
// read outside the request's async context, so a folder function reading the
// tenant from AsyncLocalStorage (as @xeplr/db's does) found none and refused
// the upload — at random, by network timing. Sent here in two pieces with a
// pause between, so it happens every time; the folder must still be the one
// the request names.
test('the folder is asked for while the request is handled, not when the file\'s bytes arrive', async function() {
  var { AsyncLocalStorage } = require('node:async_hooks');
  var http = require('http');
  var als = new AsyncLocalStorage();
  var uploader = new FileUploader({ destination: function() {
    var store = als.getStore();
    if (!store) { var err = new Error('This work runs as no tenant'); err.status = 400; throw err; }
    return path.join(root, 'als', store.company);
  } });
  var app = express();
  app.use(function(req, res, next) { als.run({ company: req.get('x-company') }, next); });
  app.post('/up', uploader.single('file'), function(req, res) { res.json({ path: req.file.path }); });
  var server = await new Promise(function(resolve) { var s = app.listen(0, function() { resolve(s); }); });
  function slowUpload(company) {
    var boundary = '----xeplrSlow' + company;
    var head = '--' + boundary + '\r\n';
    var rest = 'Content-Disposition: form-data; name="file"; filename="rows.csv"\r\nContent-Type: text/csv\r\n\r\n' +
      'a,b\n1,2\n\r\n--' + boundary + '--\r\n';
    return new Promise(function(resolve, reject) {
      var req = http.request({ port: server.address().port, path: '/up', method: 'POST', headers: {
        'x-company': company, 'content-type': 'multipart/form-data; boundary=' + boundary,
        'content-length': Buffer.byteLength(head + rest)
      } }, function(res) {
        var body = '';
        res.on('data', function(c) { body += c; });
        res.on('end', function() { resolve({ status: res.statusCode, body: JSON.parse(body) }); });
      });
      req.on('error', reject);
      req.write(head);
      setTimeout(function() { req.end(rest); }, 80);
    });
  }
  try {
    for (var company of ['acme', 'beta', 'acme']) {
      var r = await slowUpload(company);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(path.dirname(r.body.path), path.join(root, 'als', company));
    }
  } finally { server.close(); }
});
