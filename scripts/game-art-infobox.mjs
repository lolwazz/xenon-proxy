/* Last-resort image finder.
 *
 * Some articles - Minecraft, Wordle, Geometry Dash - return no thumbnail and
 * no originalimage from the summary endpoint even though their infobox clearly
 * has cover art. PageImages simply has no entry for them. The picture is still
 * in the rendered article, so pull it straight out of the infobox.
 *
 * Usage: node scripts/game-art-infobox.mjs
 */
import fs from 'node:fs';

const UA = 'XenonPortal/1.0 (personal school portal)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function infoboxImage(title) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/html/' + encodeURIComponent(title),
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) return null;
      const html = await r.text();
      // Narrow to the infobox first, otherwise we grab a navbox icon or a flag.
      const box = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[\s\S]{0,20000}?<\/table>/i);
      const scope = box ? box[0] : html.slice(0, 40000);
      const imgs = [...scope.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
      for (const raw of imgs) {
        const src = raw.startsWith('//') ? 'https:' + raw : raw;
        if (!/(upload|thumb)\.wikimedia\.org/.test(src)) continue;
        // Skip UI furniture: icons, edit pencils, audio glyphs, tiny flags.
        if (/\/(\d{1,2})px-/.test(src)) continue;
        if (/Commons-logo|Wiki_letter|Edit-clear|Question_book|Ambox|Symbol_|Loudspeaker|Icon/i.test(src)) continue;
        /* Wikimedia 400s on widths it has not pre-rendered, so keep the size the article itself used. */
        return src.split("?")[0];
      }
      return null;
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

const games = JSON.parse(fs.readFileSync('public/g/popular.json', 'utf8'));
const art = JSON.parse(fs.readFileSync('public/g/art.json', 'utf8'));
const ov = JSON.parse(fs.readFileSync('scripts/game-art-overrides.json', 'utf8'));

let added = 0;
for (const g of games) {
  const key = g.f || g.t;
  if (art[key]) continue;                    // already has art
  const want = ov[g.t];
  if (!want) continue;                       // no known article, or explicitly none
  const img = await infoboxImage(want);
  await sleep(1500);
  if (!img) { console.log('  none   ' + g.t.padEnd(24).slice(0, 24) + ' (' + want + ')'); continue; }
  art[key] = { t: g.t, article: want, img, free: /\/wikipedia\/commons\//.test(img) };
  added++;
  console.log('  got    ' + g.t.padEnd(24).slice(0, 24) + ' -> ' + want + '   ' + img.split('/').pop().slice(0, 40));
}

fs.writeFileSync('public/g/art.json', JSON.stringify(art, null, 1));
const total = Object.keys(art).length;
console.log('');
console.log('  added ' + added + ' from infoboxes');
console.log('  art.json now covers ' + total + '/' + games.length + ' (' + Math.round(total / games.length * 100) + '%)');
