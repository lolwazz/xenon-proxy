/* Flip the DuckDNS record between the two ways Xenon can be reached.
 *
 *   lan     -> current 192.168.x address. Fast, works on the home wifi only,
 *              and only on devices whose DNS is not the router (it strips
 *              private-IP answers - see the hosts-file note in the readme).
 *   public  -> this network's public IP. Works from anywhere, but needs a
 *              router port forward of 443 to this machine.
 *
 * Usage: node scripts/duckdns-mode.mjs lan|public|show
 */
import 'dotenv/config';
import os from 'node:os';

const DOMAIN = process.env.DUCKDNS_DOMAIN;
const TOKEN = process.env.DUCKDNS_TOKEN;
if (!DOMAIN || !TOKEN) {
  console.error('DUCKDNS_DOMAIN and DUCKDNS_TOKEN must be set in .env');
  process.exit(1);
}

function lanIp() {
  /* Prefer a 192.168.1.x address: that is the subnet the router hands out
     and the one a port forward would point at. */
  const all = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  return all.find((a) => a.startsWith('192.168.1.')) || all[0];
}

async function publicIp() {
  const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) });
  return (await r.text()).trim();
}

async function setIp(ip) {
  const url = 'https://www.duckdns.org/update?domains=' + DOMAIN +
              '&token=' + TOKEN + '&ip=' + ip;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = (await r.text()).trim();
  if (body !== 'OK') throw new Error('duckdns refused: ' + body);
  return ip;
}

const mode = (process.argv[2] || 'show').toLowerCase();

if (mode === 'show') {
  console.log('lan address:    ' + lanIp());
  console.log('public address: ' + await publicIp());
  console.log('');
  console.log('run:  node scripts/duckdns-mode.mjs lan     (home wifi, no port forward)');
  console.log('      node scripts/duckdns-mode.mjs public  (anywhere, needs 443 forwarded)');
} else if (mode === 'lan') {
  console.log(DOMAIN + '.duckdns.org -> ' + await setIp(lanIp()) + '  (lan mode)');
} else if (mode === 'public') {
  console.log(DOMAIN + '.duckdns.org -> ' + await setIp(await publicIp()) + '  (public mode)');
} else {
  console.error('unknown mode: ' + mode + '  (use lan, public or show)');
  process.exit(1);
}
