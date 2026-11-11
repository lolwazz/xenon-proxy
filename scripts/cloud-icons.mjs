/* Downloads each cloud-gaming service's own icon into public/brand/cloud/.
 *
 * Hotlinking a third-party icon service would put a request to someone else's
 * server on every page view, and the school filter blocks plenty of those, so
 * the files are copied here once and served from the proxy.
 *
 * Order of preference: apple-touch-icon (always a real square logo, usually
 * 180px), then the largest declared <link rel="icon">, then /favicon.ico.
 *
 * Usage: node scripts/cloud-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/* `pin` is a URL found by hand that beats whatever the homepage declares -
   several of these sites list only a 32px favicon in their <head> while
   serving a 152 or 192 elsewhere. Without the pin the auto-discovery picks
   the small one and the tiles look mushy. */
const SERVICES = [
  { slug: 'geforcenow', host: 'play.geforcenow.com', alt: 'www.nvidia.com',
    pin: 'https://play.geforcenow.com/apple-touch-icon.png' },                       // 152
  { slug: 'xbox', host: 'www.xbox.com' },                                            // 512
  { slug: 'luna', host: 'luna.amazon.com', alt: 'www.amazon.com' },                  // 128
  { slug: 'nowgg', host: 'now.gg',
    pin: 'https://cdn.now.gg/apps-content/common/img/favicon-192.ico' },              // 192
  { slug: 'cloudmoon', host: 'www.cloudmoonapp.com',
    pin: 'https://www.cloudmoonapp.com/favicon.ico' },                                // .ico may hold >32
  { slug: 'boosteroid', host: 'boosteroid.com', alt: 'cloud.boosteroid.com' },        // 48 is all they publish
  { slug: 'shadow', host: 'shadow.tech', alt: 'www.shadow.tech' },                    // svg
];

const OUT = 'public/brand/cloud';

async function get(url, asBuffer) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: asBuffer ? 'image/*,*/*' : 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
}

/* Pull every icon <link> out of the head, biggest first. */
function iconLinks(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/\bicon\b/i.test(rel)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const sizes = (tag.match(/sizes=["'](\d+)/i) || [])[1];
    let px = sizes ? parseInt(sizes, 10) : 0;
    /* An apple-touch-icon is a square logo by definition and is the safest
       pick even when it declares no size. */
    if (/apple-touch-icon/i.test(rel) && !px) px = 180;
    if (/\.svg($|\?)/i.test(href)) px = Math.max(px, 512); // scalable, best of all
    try {
      out.push({ url: new URL(href, base).href, px });
    } catch {
      /* malformed href - skip */
    }
  }
  return out.sort((a, b) => b.px - a.px);
}

function extFor(url, buf) {
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.slice(0, 3).toString('hex') === 'ffd8ff') return '.jpg';
  if (buf.slice(0, 4).toString() === 'RIFF') return '.webp';
  if (buf.slice(0, 5).toString().toLowerCase().includes('<svg') || /\.svg($|\?)/i.test(url)) return '.svg';
  if (buf.slice(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return '.ico';
  return '';
}

fs.mkdirSync(OUT, { recursive: true });

const results = [];
for (const s of SERVICES) {
  const hosts = [s.host, s.alt].filter(Boolean);
  let saved = null;

  for (const host of hosts) {
    const base = 'https://' + host + '/';
    let candidates = [];
    if (s.pin && host === hosts[0]) candidates.push({ url: s.pin, px: 9999 });
    try {
      candidates = candidates.concat(iconLinks(await get(base), base));
    } catch (e) {
      /* Plenty of these block a plain GET; the favicon path often still works. */
    }
    candidates.push({ url: base + 'favicon.ico', px: 0 });
    candidates.push({ url: base + 'apple-touch-icon.png', px: 180 });

    for (const c of candidates.slice(0, 6)) {
      try {
        const buf = await get(c.url, true);
        if (buf.length < 200) continue; // an error page, not an image
        const ext = extFor(c.url, buf);
        if (!ext) continue;
        const file = path.join(OUT, s.slug + ext);
        fs.writeFileSync(file, buf);
        saved = { file, ext, bytes: buf.length, px: c.px, from: c.url };
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (saved) break;
  }

  results.push({ slug: s.slug, saved });
  console.log(
    '  ' +
      s.slug.padEnd(12) +
      (saved
        ? saved.ext.padEnd(5) + String(saved.bytes).padStart(7) + 'b  ' + saved.from.slice(0, 64)
        : 'FAILED - no icon found'),
  );
}

const ok = results.filter((r) => r.saved).length;
console.log('');
console.log('  ' + ok + '/' + SERVICES.length + ' icons saved to ' + OUT);
fs.writeFileSync(
  path.join(OUT, 'index.json'),
  JSON.stringify(
    Object.fromEntries(results.filter((r) => r.saved).map((r) => [r.slug, path.basename(r.saved.file)])),
    null,
    1,
  ),
);
