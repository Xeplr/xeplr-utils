// Every path the README says can be required (@xeplr/utils/lib/<name>) is in
// package.json's "exports" — one left out fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED for anyone requiring it from outside
// (lib/sharedBudget shipped that way in 2.0.3 and 1.1.4).
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

test('each path the README lists is exported', function() {
  var exp = require('../package.json').exports;
  var readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  var listed = Array.from(new Set(readme.match(/@xeplr\/utils\/lib\/[A-Za-z-]+/g) || []));
  assert.ok(listed.length > 5, 'the README lists its paths');
  listed.forEach(function(p) {
    var key = './' + p.replace('@xeplr/utils/', '');
    assert.ok(exp[key], key + ' is in the README but missing from "exports"');
  });
});
