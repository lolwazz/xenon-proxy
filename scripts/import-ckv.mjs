/* Imports the gmshelf/ckv collection into public/g.
 *
 * Shape of the source: 849 games listed in ckv.json, but 1,697 html files on
 * disk - each listed game is a wrapper that frames a second file next to it
 * ("10minutestilldawn.html" holds src="10minutestilldawn2.html"). So the whole
 * folder is copied flat rather than just the listed entries, and it has to
 * stay flat: 1,690 of those files reference their assets relatively, and that
 * only resolves if they keep sitting beside each other.
 *
 * Every one of them ships a Google Analytics tag. This is a site a whole
 * school is going to use, so those come out on the way in.
 *
 * Usage: node scripts/import-ckv.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/mooma/Downloads/fd/_gmshelf/ckv';
const DST = 'public/g';
const DRY = process.argv.includes('--dry');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'ckv.json'), 'utf8'));
const games = Array.isArray(manifest) ? manifest : Object.values(manifest).find(Array.isArray);
console.log('  listed games: ' + games.length);

const index = JSON.parse(fs.readFileSync(path.join(DST, 'index.json'), 'utf8'));
const covers = JSON.parse(fs.readFileSync(path.join(DST, 'covers.json'), 'utf8'));
const have = new Set(fs.readdirSync(DST).filter((f) => f.endsWith('.html')));
console.log('  already in the library: ' + index.length + ' games, ' + Object.keys(covers).length + ' covers');

/* ---------------------------------------------------------- trackers --- */
const TAG = /<script[^>]*googletagmanager\.com[^>]*><\/script>/gi;
/* The inline block that follows it - matched by its contents, not position,
 * since a few files put other scripts in between. */
const INLINE = /<script>\s*window\.dataLayer[\s\S]{0,400}?<\/script>/gi;
const OTHER = /<script[^>]*(google-analytics\.com|hotjar|clarity\.ms|doubleclick)[^>]*>[\s\S]{0,300}?<\/script>/gi;

function clean(html) {
  let out = html.replace(TAG, '').replace(INLINE, '').replace(OTHER, '');
  return out;
}

/* ------------------------------------------------------------- files --- */
const htmlFiles = fs.readdirSync(path.join(SRC, 'ckv')).filter((f) => f.endsWith('.html'));
const clashes = htmlFiles.filter((f) => have.has(f));
console.log('  html files to copy: ' + htmlFiles.length + '  (skipping ' + clashes.length + ' already present: '
  + clashes.join(', ') + ')');

let copied = 0, stripped = 0;
if (!DRY) {
  for (const f of htmlFiles) {
    if (have.has(f)) continue;
    const raw = fs.readFileSync(path.join(SRC, 'ckv', f), 'utf8');
    const out = clean(raw);
    if (out !== raw) stripped++;
    fs.writeFileSync(path.join(DST, f), out);
    copied++;
  }
}

/* Support folders the games load from, kept at the same relative depth. */
const dirs = fs.readdirSync(path.join(SRC, 'ckv'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);
let dirFiles = 0;
if (!DRY) {
  for (const d of dirs) {
    const from = path.join(SRC, 'ckv', d);
    const to = path.join(DST, d);
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    dirFiles += fs.readdirSync(from, { recursive: true }).length;
  }
}
console.log('  support folders: ' + dirs.join(', '));

/* ------------------------------------------------------------ covers --- */
fs.mkdirSync(path.join(DST, 'covers'), { recursive: true });
let coverCount = 0;
const srcCovers = fs.existsSync(path.join(SRC, 'covers')) ? fs.readdirSync(path.join(SRC, 'covers')) : [];
if (!DRY) {
  for (const c of srcCovers) {
    const to = path.join(DST, 'covers', c);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(SRC, 'covers', c), to);
    coverCount++;
  }
}

/* ------------------------------------------------- index and mapping --- */
const known = new Set(index.map((g) => g.f));
let added = 0, mapped = 0;
for (const g of games) {
  const file = path.basename(String(g.url || ''));
  if (!file.endsWith('.html')) continue;
  if (clashes.includes(file)) continue;
  if (!known.has(file)) {
    /* ckv names are slugs; title-case them so they read like the rest. */
    const title = String(g.name || file.replace(/\.html$/, ''));
    index.push({ f: file, t: title });
    known.add(file);
    added++;
  }
  const img = path.basename(String(g.img || ''));
  if (img && !/placeholder/i.test(img) && srcCovers.includes(img)) {
    covers[file] = 'covers/' + img;
    mapped++;
  }
}

if (!DRY) {
  fs.writeFileSync(path.join(DST, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(DST, 'covers.json'), JSON.stringify(covers, null, 1));
}

console.log('');
console.log('  copied html:     ' + copied + '  (trackers stripped from ' + stripped + ')');
console.log('  support files:   ' + dirFiles);
console.log('  covers copied:   ' + coverCount);
console.log('  index entries:   +' + added + '  -> ' + index.length);
console.log('  covers mapped:   +' + mapped + '  -> ' + Object.keys(covers).length);
if (DRY) console.log('');
if (DRY) console.log('  dry run - nothing written');
