import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

/* Name lookups for everything this server fetches (proxied sites, games,
 * images, AI providers) go through public DNS first.
 *
 * The home router's DNS (192.168.1.254 / 192.168.2.254) is unreliable: it
 * already refuses trycloudflare.com names, and on 2026-10-21 it stopped
 * answering at all - every lookup timed out, so the proxy could reach no
 * site and every game came up black. Asking 1.1.1.1 / 8.8.8.8 directly takes
 * the router out of the path; the system resolver is only the fallback.
 *
 * net, http, https, tls and fetch (undici) all resolve through dns.lookup at
 * call time, so replacing it here covers every outgoing connection. Imported
 * first by server.js.
 */

const resolver = new dns.Resolver({ timeout: 2500, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
const systemLookup = dns.lookup;
const cache = new Map();                  // host|family -> {list, exp}

function resolveVia(host, family) {
  const key = host + '|' + family;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.list);
  const want4 = family !== 6, want6 = family === 6 || family === 0;
  const jobs = [];
  if (want4) jobs.push(new Promise((ok) => resolver.resolve4(host, { ttl: true }, (e, a) => ok(e ? [] : a.map((x) => ({ address: x.address, family: 4, ttl: x.ttl }))))));
  if (want6) jobs.push(new Promise((ok) => resolver.resolve6(host, { ttl: true }, (e, a) => ok(e ? [] : a.map((x) => ({ address: x.address, family: 6, ttl: x.ttl }))))));
  return Promise.all(jobs).then((parts) => {
    const list = parts.flat();
    if (list.length) {
      const ttl = Math.max(30, Math.min(600, Math.min(...list.map((x) => x.ttl || 300))));
      cache.set(key, { list, exp: Date.now() + ttl * 1000 });
      if (cache.size > 5000) for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
    }
    return list;
  });
}

function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family || 0);
  const host = String(hostname || '');
  /* Addresses, localhost and names without a dot (LAN) stay with the system. */
  if (!host || net.isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.indexOf('.') === -1) {
    return systemLookup(hostname, options, callback);
  }
  resolveVia(host, family).then((list) => {
    if (!list.length) return systemLookup(hostname, options, callback);
    /* Prefer IPv4: this connection's IPv6 has been unreliable too. */
    list = list.slice().sort((a, b) => a.family - b.family);
    if (options.all) return callback(null, list.map(({ address, family: f }) => ({ address, family: f })));
    callback(null, list[0].address, list[0].family);
  }, () => systemLookup(hostname, options, callback));
}

dns.lookup = lookup;
if (dns.promises) {
  dns.promises.lookup = (hostname, options) => new Promise((ok, fail) => {
    lookup(hostname, options, (err, address, fam) => {
      if (err) return fail(err);
      ok(Array.isArray(address) ? address : { address, family: fam });
    });
  });
}
/* Modules that import { lookup } from 'node:dns' get the new one too. */
syncBuiltinESMExports();
