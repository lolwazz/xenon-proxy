/**
 * Keeps a Bunny CDN pull zone pointed at the live tunnel.
 *
 * A pull zone needs a fixed origin, but a quick tunnel gets a new hostname
 * every restart. So each time the tunnel comes up we PATCH the zone's origin
 * via Bunny's API. The b-cdn.net hostname then stays constant forever, which
 * is the whole point: visitors get one stable URL even though what sits behind
 * it keeps changing.
 *
 * Needs BUNNY_API_KEY and BUNNY_ZONE_ID in .env. Without them this is a no-op.
 */
const API = 'https://api.bunny.net';

export const bunnyEnabled = Boolean(process.env.BUNNY_API_KEY && process.env.BUNNY_ZONE_ID);

export async function pointZoneAt(originUrl) {
  if (!bunnyEnabled) return { skipped: true };
  const key = process.env.BUNNY_API_KEY;
  const zone = process.env.BUNNY_ZONE_ID;
  try {
    const r = await fetch(`${API}/pullzone/${encodeURIComponent(zone)}`, {
      method: 'POST',
      headers: { AccessKey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        OriginUrl: originUrl,
        // A proxy must never be cached: a page fetched for one person would
        // otherwise be handed to the next. 0 = do not cache.
        CacheControlMaxAgeOverride: 0,
        CacheControlBrowserMaxAgeOverride: 0,
        // Proxied URLs live entirely in the query string (?u=...), so the
        // cache key has to include it or every target collapses into one.
        IgnoreQueryStrings: false,
        EnableCacheSlice: false,
        // The tunnel decides its own Host; forwarding ours breaks it.
        AddHostHeader: false,
      }),
    });
    if (!r.ok) {
      return { ok: false, status: r.status, body: (await r.text()).slice(0, 160) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 120) };
  }
}

export async function zoneHostname() {
  if (!bunnyEnabled) return '';
  try {
    const r = await fetch(`${API}/pullzone/${encodeURIComponent(process.env.BUNNY_ZONE_ID)}`, {
      headers: { AccessKey: process.env.BUNNY_API_KEY },
    });
    if (!r.ok) return '';
    const j = await r.json();
    const host = (j.Hostnames || []).find((h) => h.Value) || null;
    return host ? `https://${host.Value}` : '';
  } catch { return ''; }
}
