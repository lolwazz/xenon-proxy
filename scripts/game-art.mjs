/* Finds a Wikipedia image for each game title.
 *
 * Two passes, because the two APIs have opposite strengths:
 *   1. action=query batches 50 titles per request and is not rate limited,
 *      but prop=pageimages omits non-free files - which is most game cover
 *      art, so it only finds about a third.
 *   2. The REST summary endpoint returns non-free covers too, but 429s after
 *      roughly four calls, so it runs slowly with backoff and only for the
 *      titles pass 1 could not fill.
 *
 * Usage: node scripts/game-art.mjs public/g/popular.json public/g/art.json
 */
import fs from 'node:fs';

const UA = 'XenonPortal/1.0 (personal school portal)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The UGS filenames produce mangled titles like "Minecraft1 8 8" or
   "Temple Run2". Split letter/digit runs apart and drop version tails. */
function clean(t) {
  return t
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/\s+(s\d|v\d|\d+\s+\d+\s+\d+)$/i, '')
    .trim();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/* Titles come from filenames, so they arrive mangled: "Minecraft1 8 8",
   "Rocketleague", "Subway Surfers Barcelona". Try several candidate queries
   rather than betting everything on one cleanup. */
function variants(t) {
  const out = [];
  const spaced = t.replace(/([a-z])([0-9])/g, '$1 $2')
                  .replace(/([0-9])([A-Za-z])/g, '$1 $2')
                  .replace(/s+/g, ' ').trim();
  out.push(spaced);
  const base = spaced.replace(/s+(d+(s+d+)*)$/, '')
                     .replace(/s+(lite|hd|online|unblocked|sd+|vd+)$/i, '').trim();
  if (base && base !== spaced) out.push(base);
  const words = base.split(' ');
  if (words.length > 2) out.push(words.slice(0, 2).join(' '));
  return [...new Set(out.filter(Boolean))];
}

/* "Minecraft" matched "A Minecraft Movie". Anything described as a film, show
   or album is the wrong medium however well the title lines up. */
const WRONG_MEDIUM = /(film|movie|tv series|television|album|song|novel|book|actor|band|musician)/i;

/* The search API will answer "Awesome Tank S2" with an article about an actor,
   so a match must share most of its words AND describe a game. */
function acceptable(game, article, desc) {
  const g = new Set(norm(game).split(' ').filter((w) => w.length > 2));
  const a = new Set(norm(article).split(' ').filter((w) => w.length > 2));
  if (!g.size) return false;
  let shared = 0;
  for (const w of g) if (a.has(w)) shared++;
  if (shared / g.size < 0.6) return false;
  if (WRONG_MEDIUM.test(desc || '')) return false;
  return /game|puzzle|arcade|platformer|sandbox/i.test(desc || '');
}

async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}

async function pass1(titles) {
  const found = {};
  for (let i = 0; i < titles.length; i += 45) {
    const slice = titles.slice(i, i + 45);
    const j = await get('https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1' +
      '&prop=pageimages|description&piprop=thumbnail&pithumbsize=400&pilimit=max&titles=' +
      encodeURIComponent(slice.join('|')));
    const pages = Object.values((j && j.query && j.query.pages) || {});
    for (const p of pages) {
      if (p.missing !== undefined) continue;
      found[norm(p.title)] = {
        article: p.title,
        desc: p.description || '',
        img: p.thumbnail ? p.thumbnail.source.split('?')[0] : null,
        free: !!p.thumbnail,
      };
    }
    process.stderr.write('  pass1 ' + Math.min(i + 45, titles.length) + '/' + titles.length + '\n');
    await sleep(300);
  }
  return found;
}

async function pass2(title) {
  const s = await get('https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=3&srsearch=' +
    encodeURIComponent(title));
  for (const hit of ((s && s.query && s.query.search) || []).slice(0, 3)) {
    const d = await get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.title));
    await sleep(1800);
    if (!d || !d.thumbnail) continue;
    if (!acceptable(title, d.title, (d.description || '') + ' ' + (d.extract || ''))) continue;
    return {
      article: d.title,
      desc: d.description || '',
      img: d.thumbnail.source.split('?')[0],
      free: /\/wikipedia\/commons\//.test(d.thumbnail.source),
    };
  }
  return null;
}

const [, , inFile, outFile] = process.argv;
const games = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const cleaned = games.map((g) => ({ ...g, q: clean(g.t) }));

const p1 = await pass1([...new Set(cleaned.map((g) => g.q))]);

const out = {};
let hits = 0, free = 0, viaP2 = 0;
for (const g of cleaned) {
  const key = g.f || g.t;
  const c = p1[norm(g.q)];
  let res = c && c.img && acceptable(g.q, c.article, c.desc) ? c : null;
  if (!res) {
    for (const q of variants(g.t)) { res = await pass2(q); if (res) break; }
    if (res) viaP2++;
  }
  if (res) {
    hits++; if (res.free) free++;
    out[key] = { t: g.t, article: res.article, img: res.img, free: res.free };
    console.log('  HIT  ' + g.t.padEnd(24).slice(0, 24) + ' -> ' + res.article.slice(0, 32) +
      (res.free ? '  [commons]' : '  [fair-use]'));
  } else {
    console.log('  miss ' + g.t.slice(0, 24));
  }
}

fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('\n  ' + hits + '/' + games.length + ' matched (' + Math.round(hits / games.length * 100) + '%)' +
  '   commons ' + free + ', fair-use ' + (hits - free) + ', found by slow pass ' + viaP2);
console.log('  written to ' + outFile);
