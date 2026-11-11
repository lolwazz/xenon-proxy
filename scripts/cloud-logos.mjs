/* Pulls each cloud-gaming service's logo out of its Wikipedia infobox.
 *
 * Favicons gave us 32-48px marks for half these services, which look like
 * mush on a tile. The infobox logo is the real wordmark or glyph. It is also
 * non-free for most of them, so PageImages has no entry and the summary
 * endpoint returns nothing - the picture only exists in the rendered article,
 * same problem the game art had.
 *
 * Falls back to whatever scripts/cloud-icons.mjs already fetched.
 *
 * Usage: node scripts/cloud-logos.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'XenonPortal/1.0 (personal school portal)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* null = no usable article, keep the favicon. */
const ARTICLES = {
  geforcenow: 'GeForce Now',
  xbox: 'Xbox Cloud Gaming',
  luna: 'Amazon Luna',
  /* now.gg's own article has no infobox image. The BlueStacks article has
     one, but it reads "BlueStacks by now.gg" - a different brand on the tile -
     so the favicon glyph is the honest choice. */
  nowgg: null,
  cloudmoon: null,
  boosteroid: 'Boosteroid',
  /* No article. "Blade (company)" is a helicopter charter, not this Shadow. */
  shadow: null,
};

async function infoboxImage(title) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/html/' + encodeURIComponent(title), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) return null;
      const html = await r.text();
      const box = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[\s\S]{0,20000}?<\/table>/i);
      const scope = box ? box[0] : html.slice(0, 40000);
      const imgs = [...scope.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
      for (const raw of imgs) {
        const src = raw.startsWith('//') ? 'https:' + raw : raw;
        if (!/(upload|thumb)\.wikimedia\.org/.test(src)) continue;
        if (/\/(\d{1,2})px-/.test(src)) continue;
        if (/Commons-logo|Wiki_letter|Edit-clear|Question_book|Ambox|Symbol_|Loudspeaker|Icon/i.test(src)) continue;
        /* Wikimedia 400s on widths it has not pre-rendered, so keep the
           size the article itself asked for. */
        return src.split('?')[0];
      }
      return null;
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

const OUT = 'public/brand/cloud';
fs.mkdirSync(OUT, { recursive: true });

const found = {};
for (const [slug, article] of Object.entries(ARTICLES)) {
  if (!article) { console.log('  ' + slug.padEnd(12) + 'skipped - no article, keeping favicon'); continue; }
  const img = await infoboxImage(article);
  await sleep(1200);
  if (!img) { console.log('  ' + slug.padEnd(12) + 'no infobox image in "' + article + '"'); continue; }

  try {
    const r = await fetch(img, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isSvg = buf.slice(0, 400).toString().toLowerCase().includes('<svg');
    const ext = isPng ? '.png' : isSvg ? '.svg' : path.extname(new URL(img).pathname) || '.png';
    const file = path.join(OUT, 'wiki-' + slug + ext);
    fs.writeFileSync(file, buf);
    const dim = isPng ? buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20) : isSvg ? 'vector' : '?';
    found[slug] = path.basename(file);
    console.log('  ' + slug.padEnd(12) + dim.padEnd(10) + String(buf.length).padStart(7) + 'b  ' + img.split('/').pop().slice(0, 46));
  } catch (e) {
    console.log('  ' + slug.padEnd(12) + 'download failed: ' + e.message);
  }
}

fs.writeFileSync(path.join(OUT, 'wiki.json'), JSON.stringify(found, null, 1));
console.log('');
console.log('  ' + Object.keys(found).length + ' logos from Wikipedia');
