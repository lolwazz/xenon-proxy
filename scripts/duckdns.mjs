/**
 * Keeps a DuckDNS hostname pointed at this machine's public IP.
 *
 * Home connections get a new IP whenever the router reconnects, so the record
 * has to be refreshed or the hostname starts pointing at a stranger. DuckDNS
 * takes a plain GET; run this on a timer and forget about it.
 *
 * Needs DUCKDNS_DOMAIN and DUCKDNS_TOKEN in .env (the subdomain only - for
 * xenon.duckdns.org put "xenon").
 */
import 'dotenv/config';

const DOMAIN = process.env.DUCKDNS_DOMAIN || '';
const TOKEN = process.env.DUCKDNS_TOKEN || '';

export const duckEnabled = Boolean(DOMAIN && TOKEN);

export async function updateDuckDns() {
  if (!duckEnabled) return { skipped: true };
  try {
    // Leaving ip blank tells DuckDNS to use the address the request came from,
    // which is exactly the public IP we want.
    const r = await fetch(
      `https://www.duckdns.org/update?domains=${encodeURIComponent(DOMAIN)}` +
      `&token=${encodeURIComponent(TOKEN)}&ip=`,
      { signal: AbortSignal.timeout(15000) },
    );
    const body = (await r.text()).trim();
    return body === 'OK'
      ? { ok: true, host: `${DOMAIN}.duckdns.org` }
      : { ok: false, body: body.slice(0, 80) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 100) };
  }
}

// Run directly:  node scripts/duckdns.mjs
const invokedDirectly = String(process.argv[1] || '').endsWith('duckdns.mjs');
if (invokedDirectly) {
  if (!duckEnabled) {
    console.log('DUCKDNS_DOMAIN / DUCKDNS_TOKEN not set in .env');
    process.exit(1);
  }
  const r = await updateDuckDns();
  console.log(r.ok ? `updated ${r.host}` : `failed: ${r.body || r.error}`);
}
