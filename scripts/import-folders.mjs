/* Imports a folder-per-game collection into public/g.
 *
 * The library has been flat until now - one html file per game, assets shared
 * in sibling folders. These collections are the other shape: each game is a
 * directory with its own index.html and its own assets beside it. Both work,
 * because a tile's url is just /g/ + whatever is in index.json, so an entry of
 * "slope/index.html" resolves the same way "slope.html" does.
 *
 * Keeping them in folders also means no filename collisions with the 2,600
 * flat files already there.
 *
 * Usage: node scripts/import-folders.mjs <source-dir> <games-subdir|.> [--dry]
 *   e.g. node scripts/import-folders.mjs ../_gmshelf/seraph seraph
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const SUB = process.argv[3] || '.';
const DRY = process.argv.includes('--dry');
const DST = 'public/g';

if (!SRC || !fs.existsSync(SRC)) { console.error('  pass a source directory'); process.exit(1); }
const GAMES = path.join(SRC, SUB);

/* Titles, if the collection ships a manifest. */
const titles = new Map();
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
    const rows = Array.isArray(j) ? j : Object.values(j).find(Array.isArray);
    if (!rows) continue;
    for (const g of rows) {
      const slug = String(g.url || '').split('/').filter(Boolean)[1];
      if (slug && g.name) titles.set(slug, String(g.name));
    }
  } catch { /* not a manifest */ }
}

/* Analytics, same removal as the flat import. */
const HOSTS = /googletagmanager\.com|google-analytics\.com|hotjar|clarity\.ms|doubleclick|gtag\/js/i;
const BODY = /\bdataLayer\b|\bgtag\s*\(/;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function clean(html) {
  return html.replace(SCRIPT, (whole, attrs, body) => {
    if (HOSTS.test(attrs)) return '';
    if (!attrs.includes('src') && BODY.test(body) && body.length <= 2000) return '';
    return whole;
  });
}

const index = JSON.parse(fs.readFileSync(path.join(DST, 'index.json'), 'utf8'));
const covers = JSON.parse(fs.readFileSync(path.join(DST, 'covers.json'), 'utf8'));
const known = new Set(index.map((g) => g.f));

const slugs = fs.readdirSync(GAMES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((s) => fs.existsSync(path.join(GAMES, s, 'index.html')));

console.log('  playable folders found: ' + slugs.length);

const srcCovers = fs.existsSync(path.join(SRC, 'covers')) ? fs.readdirSync(path.join(SRC, 'covers')) : [];
/* Covers already in the library, reusable when this collection ships none. */
const haveCovers = fs.readdirSync(path.join(DST, 'covers'));

let copied = 0, scrubbed = 0, added = 0, mapped = 0, skipped = 0, files = 0;

for (const slug of slugs) {
  const from = path.join(GAMES, slug);
  const to = path.join(DST, slug);
  const entry = slug + '/index.html';

  if (fs.existsSync(to)) { skipped++; continue; }

  if (!DRY) {
    fs.cpSync(from, to, { recursive: true });
    /* Scrub every html inside, not just the entry point. */
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { walk(p); continue; }
        files++;
        if (!/\.html?$/i.test(d.name)) continue;
        let h;
        try { h = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (!HOSTS.test(h) && !BODY.test(h)) continue;
        const out = clean(h);
        if (out !== h) { fs.writeFileSync(p, out); scrubbed++; }
      }
    };
    walk(to);
  }
  copied++;

  if (!known.has(entry)) {
    index.push({ f: entry, t: titles.get(slug) || slug });
    known.add(entry);
    added++;
  }

  /* Cover: this collection's own, else one already in the library. */
  let pick = srcCovers.find((c) => c.replace(/\.[a-z]+$/i, '') === slug);
  if (pick) {
    if (!DRY) {
      const dstCover = path.join(DST, 'covers', pick);
      if (!fs.existsSync(dstCover)) fs.copyFileSync(path.join(SRC, 'covers', pick), dstCover);
    }
    covers[entry] = 'covers/' + pick;
    mapped++;
  } else {
    const reuse = haveCovers.find((c) => c.replace(/\.[a-z]+$/i, '') === slug);
    if (reuse) { covers[entry] = 'covers/' + reuse; mapped++; }
  }
}

if (!DRY) {
  fs.writeFileSync(path.join(DST, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(DST, 'covers.json'), JSON.stringify(covers, null, 1));
}

console.log('  copied folders:  ' + copied + '  (already present: ' + skipped + ')');
console.log('  files copied:    ' + files);
console.log('  html scrubbed:   ' + scrubbed);
console.log('  index entries:   +' + added + '  -> ' + index.length);
console.log('  covers mapped:   +' + mapped + '  -> ' + Object.keys(covers).length);
if (DRY) console.log('  dry run - nothing written');
