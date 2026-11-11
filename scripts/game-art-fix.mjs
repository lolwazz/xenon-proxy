/* Applies scripts/game-art-overrides.json on top of art.json.
 *
 * The search-based finder guesses badly on short or mangled names - it offered
 * an actor for "Awesome Tank S2" and Cro-Magnon for "Crossy Road". For games
 * anyone would recognise it is faster and far more accurate to name the
 * article outright and just fetch its image.
 *
 * Usage: node scripts/game-art-fix.mjs
 */
import fs from 'node:fs';

const UA = 'XenonPortal/1.0 (personal school portal)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function summary(title, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

const games = JSON.parse(fs.readFileSync('public/g/popular.json', 'utf8'));
const art = JSON.parse(fs.readFileSync('public/g/art.json', 'utf8'));
const ov = JSON.parse(fs.readFileSync('scripts/game-art-overrides.json', 'utf8'));

let added = 0, fixed = 0, dropped = 0;
for (const g of games) {
  if (!(g.t in ov)) continue;
  const want = ov[g.t];
  const key = g.f || g.t;

  if (want === '') {
    if (art[key]) { delete art[key]; dropped++; console.log('  dropped  ' + g.t + ' (no article exists)'); }
    continue;
  }

  const d = await summary(want);
  await sleep(1800);
  if (!d || !d.thumbnail) { console.log('  no image ' + g.t + ' -> ' + want); continue; }

  const was = art[key];
  art[key] = {
    t: g.t,
    article: d.title,
    img: d.thumbnail.source.split('?')[0],
    free: /\/wikipedia\/commons\//.test(d.thumbnail.source),
  };
  if (was) { fixed++; console.log('  fixed    ' + g.t.padEnd(24).slice(0, 24) + ' ' + was.article.slice(0, 22) + '  ->  ' + d.title); }
  else { added++; console.log('  added    ' + g.t.padEnd(24).slice(0, 24) + ' -> ' + d.title); }
}

fs.writeFileSync('public/g/art.json', JSON.stringify(art, null, 1));
const total = Object.keys(art).length;
console.log('');
console.log('  added ' + added + ', fixed ' + fixed + ', dropped ' + dropped);
console.log('  art.json now covers ' + total + '/' + games.length + ' (' + Math.round(total / games.length * 100) + '%)');
