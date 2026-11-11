/* Puts the downloaded selenite folders into the library manifests.
 *
 * The files were fetched straight into public/g, so nothing needs copying -
 * this only adds the index entries, finds each one a cover, and takes the
 * analytics out. It also reports which games reach for assets at the site
 * root, because those are the ones that render black.
 *
 * Usage: node scripts/register-selenite.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DST = 'public/g';
const SP = 'C:/Users/mooma/AppData/Local/Temp/claude/C--Users-mooma-Downloads-fd/28213aad-261a-4575-ad14-8c0ce5d60f7d/scratchpad';

const want = JSON.parse(fs.readFileSync(SP + '/selenite-new.json', 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(DST, 'index.json'), 'utf8'));
const covers = JSON.parse(fs.readFileSync(path.join(DST, 'covers.json'), 'utf8'));
const known = new Set(index.map((g) => g.f));
const haveCovers = fs.readdirSync(path.join(DST, 'covers'));

const HOSTS = /googletagmanager\.com|google-analytics\.com|hotjar|clarity\.ms|doubleclick|gtag\/js/i;
const BODY = /\bdataLayer\b|\bgtag\s*\(/;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const clean = (h) => h.replace(SCRIPT, (whole, attrs, body) => {
  if (HOSTS.test(attrs)) return '';
  if (!attrs.includes('src') && BODY.test(body) && body.length <= 2000) return '';
  return whole;
});

/* A title from a slug: "fireboywatergirl2" stays as is, but "drift-boss" and
 * "adventure-capitalist" read better with the hyphens turned into spaces. */
const title = (s) => s.split(/[-_]/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

let added = 0, mapped = 0, scrubbed = 0, rootAbs = [];

for (const g of want) {
  const entry = g.slug + '/index.html';
  const dir = path.join(DST, g.slug);
  if (!fs.existsSync(path.join(dir, 'index.html'))) continue;

  /* Scrub every html in the folder. */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.html?$/i.test(e.name)) continue;
      let h;
      try { h = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (!HOSTS.test(h) && !BODY.test(h)) continue;
      const out = clean(h);
      if (out !== h) { if (!DRY) fs.writeFileSync(p, out); scrubbed++; }
    }
  };
  walk(dir);

  const head = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  if (/(src|href)="\/(js|css|img|images|assets|storage)\//.test(head)) rootAbs.push(g.slug);

  if (!known.has(entry)) { index.push({ f: entry, t: title(g.slug) }); known.add(entry); added++; }

  const hit = haveCovers.find((c) => c.replace(/\.[a-z]+$/i, '').toLowerCase() === g.slug.toLowerCase());
  if (hit) { covers[entry] = 'covers/' + hit; mapped++; }
}

if (!DRY) {
  fs.writeFileSync(path.join(DST, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(DST, 'covers.json'), JSON.stringify(covers, null, 1));
}

console.log('  index entries:  +' + added + '  -> ' + index.length);
console.log('  covers matched: +' + mapped + '  (from covers already in the library)');
console.log('  html scrubbed:  ' + scrubbed);
console.log('  reach for site-root assets: ' + rootAbs.length
  + (rootAbs.length ? '  (' + rootAbs.slice(0, 8).join(', ') + ')' : ''));
if (DRY) console.log('  dry run - nothing written');
