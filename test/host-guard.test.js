// isInternalHost: our own machine, private networks and link-local are
// internal, by address and by name (real DNS: localhost, and a public name).
var test = require('node:test');
var assert = require('node:assert/strict');
var os = require('os');
var { isInternalHost, internalReason } = require('../lib/hostGuard');

test('addresses: loopback, any, private, carrier NAT, link-local, IPv6 kinds, IPv4 inside IPv6', function() {
  [
    ['127.0.0.1', 'loopback (this machine)'], ['127.255.1.2', 'loopback (this machine)'], ['0.0.0.0', 'this host'],
    ['10.1.2.3', 'a private network'], ['172.16.0.1', 'a private network'], ['172.31.255.255', 'a private network'],
    ['192.168.1.10', 'a private network'], ['100.64.0.1', 'a carrier-NAT private network'],
    ['169.254.169.254', 'link-local (the cloud metadata address)'],
    ['::1', 'loopback (this machine)'], ['::', 'this host'], ['fd12:3456::1', 'a private network'], ['fe80::1', 'link-local'],
    ['::ffff:127.0.0.1', 'loopback (this machine)'], ['[::1]', 'loopback (this machine)']
  ].forEach(function(c) { assert.equal(internalReason(c[0]), c[1], c[0]); });
  ['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '2001:4860:4860::8888', '1.1.1.1'].forEach(function(ip) {
    assert.equal(internalReason(ip), null, ip + ' is public');
  });
  assert.equal(internalReason('not an ip'), null);
});

test('an address of one of this machine\'s own interfaces is internal', function() {
  var mine = [];
  var all = os.networkInterfaces();
  Object.keys(all).forEach(function(n) { (all[n] || []).forEach(function(a) { mine.push(a.address); }); });
  mine.forEach(function(ip) { assert.ok(internalReason(ip), ip + ' (own interface) is internal'); });
});

test('names: localhost and *.localhost; a name resolving to loopback; a public name; one that does not resolve', async function() {
  assert.deepEqual(await isInternalHost('localhost'), { internal: true, resolved: true, addresses: ['localhost'], reason: 'loopback (this machine)' });
  assert.equal((await isInternalHost('db.localhost')).internal, true);
  assert.equal((await isInternalHost('LOCALHOST')).internal, true);
  assert.equal((await isInternalHost('127.0.0.1')).internal, true);
  assert.equal((await isInternalHost(' 10.0.0.5 ')).internal, true);
  // localtest.me is a public DNS name that answers 127.0.0.1 — the trick a check by name alone misses.
  var tricky = await isInternalHost('localtest.me');
  if (tricky.resolved) assert.equal(tricky.internal, true, 'a public name pointing at 127.0.0.1 is internal');
  var pub = await isInternalHost('one.one.one.one');
  if (pub.resolved) assert.equal(pub.internal, false, 'a public name is not');
  var none = await isInternalHost('no-such-host.invalid');
  assert.deepEqual(none, { internal: false, resolved: false, addresses: [], reason: null });
  assert.deepEqual(await isInternalHost(''), { internal: false, resolved: false, addresses: [], reason: null });
  assert.deepEqual(await isInternalHost(null), { internal: false, resolved: false, addresses: [], reason: null });
});
