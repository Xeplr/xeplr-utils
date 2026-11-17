// IS THIS HOST US? — for an app that lets its users name a server to connect
// to (a database login, an API's base URL) while running on a server of its
// own. A user who may type any host may type ours: `localhost`, our private
// address, the cloud's metadata address — and reach a database or service
// that was never theirs, using whatever trust our own machine is given.
//
//   var { isInternalHost } = require('@xeplr/utils/lib/hostGuard')
//   var found = await isInternalHost(login.host)
//   if (found.internal) refuse('...' + found.reason)
//
// INTERNAL means any address the name stands for is:
//   - this machine: loopback (127.0.0.0/8, ::1), "any" (0.0.0.0, ::), or an
//     address of one of this machine's own network interfaces
//   - a private network: 10/8, 172.16/12, 192.168/16, 100.64/10 (carrier
//     NAT), fc00::/7 (unique local)
//   - link-local: 169.254/16 — the cloud metadata service lives there — and
//     fe80::/10
//   - IPv4 written inside IPv6 (::ffff:127.0.0.1) is judged as the IPv4
//
// A NAME is resolved, every address it has, and is internal if ANY of them
// is. A name that does not resolve is reported as such (resolved: false), not
// as internal: the caller decides; refusing it is the safe choice where the
// check guards a connection about to be made.
//
// Checking when a connection is SAVED is not enough on its own: a public name
// can later be pointed at 127.0.0.1. Check again just before connecting.

var dns = require('dns');
var net = require('net');
var os = require('os');

/** IPv4 dotted string → 32-bit number. */
function v4ToInt(ip) {
  return ip.split('.').reduce(function(n, part) { return (n * 256) + Number(part); }, 0);
}

function inV4(ip, base, bits) {
  var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

var V4_RANGES = [
  ['0.0.0.0', 8, 'this host'],
  ['127.0.0.0', 8, 'loopback (this machine)'],
  ['10.0.0.0', 8, 'a private network'],
  ['172.16.0.0', 12, 'a private network'],
  ['192.168.0.0', 16, 'a private network'],
  ['100.64.0.0', 10, 'a carrier-NAT private network'],
  ['169.254.0.0', 16, 'link-local (the cloud metadata address)']
];

/** The addresses of this machine's own network interfaces, lower-cased. */
function ownAddresses() {
  var out = [];
  var all = os.networkInterfaces();
  Object.keys(all).forEach(function(name) {
    (all[name] || []).forEach(function(a) { out.push(String(a.address).toLowerCase().replace(/%.*$/, '')); });
  });
  return out;
}

/**
 * Why an IP address is internal, or null when it is not.
 * @param {string} ip
 * @returns {string|null}
 */
function internalReason(ip) {
  var addr = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  var mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) addr = mapped[1];
  if (net.isIPv4(addr)) {
    for (var i = 0; i < V4_RANGES.length; i++) {
      if (inV4(addr, V4_RANGES[i][0], V4_RANGES[i][1])) return V4_RANGES[i][2];
    }
  } else if (net.isIPv6(addr)) {
    if (addr === '::1') return 'loopback (this machine)';
    if (addr === '::') return 'this host';
    var first = parseInt(addr.split(':')[0] || '0', 16);
    if ((first & 0xFE00) === 0xFC00) return 'a private network';
    if ((first & 0xFFC0) === 0xFE80) return 'link-local';
  } else {
    return null;
  }
  if (ownAddresses().indexOf(addr) !== -1) return 'an address of this server';
  return null;
}

/**
 * Whether `host` (a name or an address) is, or resolves to, anything internal.
 *
 * @param {string} host
 * @returns {Promise<{ internal: boolean, resolved: boolean, addresses: string[], reason: string|null }>}
 */
async function isInternalHost(host) {
  var name = String(host == null ? '' : host).trim().replace(/^\[|\]$/g, '');
  if (!name) return { internal: false, resolved: false, addresses: [], reason: null };
  if (/^localhost$|\.localhost$/i.test(name)) {
    return { internal: true, resolved: true, addresses: [name], reason: 'loopback (this machine)' };
  }
  var addresses;
  if (net.isIP(name)) addresses = [name];
  else {
    try {
      addresses = (await dns.promises.lookup(name, { all: true, verbatim: true })).map(function(a) { return a.address; });
    } catch (e) {
      return { internal: false, resolved: false, addresses: [], reason: null };
    }
  }
  for (var i = 0; i < addresses.length; i++) {
    var reason = internalReason(addresses[i]);
    if (reason) return { internal: true, resolved: true, addresses: addresses, reason: reason };
  }
  return { internal: false, resolved: true, addresses: addresses, reason: null };
}

module.exports = { isInternalHost: isInternalHost, internalReason: internalReason };
