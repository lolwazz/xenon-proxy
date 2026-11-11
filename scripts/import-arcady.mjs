/* Imports the games out of the Arcady Revamped dump into public/g/.
 *
 * Only the games folder is taken - none of the Arcady site chrome.
 *
 * Two things make this different from the UGS dump already in public/g/:
 *
 *  - The filenames are real titles ("10 Minutes Till Dawn.html"), so no
 *    dictionary splitting is needed. They are written to arcady-titles.json
 *    so a later build-games.mjs run keeps them instead of re-guessing.
 *  - Every file carries the Arcady owner's Google Analytics tag, and some
 *    carry AdSense. Those are stripped: they report every game you open to a
 *    third party's dashboard, and they are not part of the game.
 *
 * Usage: node scripts/import-arcady.mjs <path-to-extracted-games-dir> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!SRC || !fs.existsSync(SRC)) {
  console.error('  pass the extracted games directory');
  process.exit(1);
}

const G = 'public/g';
const INDEX = path.join(G, 'index.json');

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const existingFiles = new Set(fs.readdirSync(G).map((f) => f.toLowerCase()));
/* Match on a squashed title too: the UGS dump calls it cl10minutestildawn.html
   and Arcady calls it "10 Minutes Till Dawn.html" - same game. */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const existingTitles = new Set(index.map((e) => norm(e.t)));
const existingStems = new Set(index.map((e) => norm(e.f.replace(/\.html?$/i, '').replace(/^cl/, ''))));

function titleFrom(name) {
  let t = name.replace(/\.html?$/i, '');
  t = t.replace(/_/g, ': ');           // "Count Masters_ Stickman Games"
  /* A leading underscore is just a sort hack in the dump, not a subtitle
     separator, so it must not become ": Fundamental Paper Novel". */
  t = t.replace(/^\s*:\s*/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function slugFrom(title) {
  return 'ar' + norm(title) + '.html';
}

/* Conservative: only the analytics and ad blocks, nothing that a game runs on.
   The <base href> these files depend on is left alone. */
function clean(html) {
  let s = html;
  const hits = { gtag: 0, ads: 0, ins: 0 };

  s = s.replace(/<script[^>]*src=["'][^"']*googletagmanager\.com[^"']*["'][^>]*>\s*<\/script>/gi,
    () => { hits.gtag++; return ''; });
  /* the inline block that configures the tag right after it */
  s = s.replace(/<script>\s*window\.dataLayer[\s\S]{0,400}?<\/script>/gi,
    () => { hits.gtag++; return ''; });
  s = s.replace(/<script[^>]*src=["'][^"']*(googlesyndication|adsbygoogle)[^"']*["'][^>]*>\s*<\/script>/gi,
    () => { hits.ads++; return ''; });
  s = s.replace(/<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][\s\S]*?<\/ins>/gi,
    () => { hits.ins++; return ''; });
  s = s.replace(/<script>\s*\(adsbygoogle\s*=[\s\S]{0,200}?<\/script>/gi,
    () => { hits.ads++; return ''; });

  return { s, hits };
}

const files = fs.readdirSync(SRC).filter((f) => /\.html?$/i.test(f));
const added = [];
const skipped = { tiny: [], dupFile: [], dupTitle: [] };
let gtagStripped = 0, adsStripped = 0, bytes = 0;

for (const f of files.sort()) {
  const full = path.join(SRC, f);
  const stat = fs.statSync(full);

  /* Three of these are the download error text, not a game. */
  if (stat.size < 500) { skipped.tiny.push(f); continue; }
  if (existingFiles.has(f.toLowerCase())) { skipped.dupFile.push(f); continue; }

  const title = titleFrom(f);
  const key = norm(title);
  if (existingTitles.has(key) || existingStems.has(key)) { skipped.dupTitle.push(title); continue; }
  /* Already imported on an earlier run: the file this would write exists.
     Titles can have been fixed since (fix-titles.mjs), so the title check
     alone let a re-import of the same zip add "-2" copies of 54 games. */
  if (existingFiles.has(slugFrom(title).toLowerCase())) { skipped.dupFile.push(f); continue; }

  let out = slugFrom(title);
  let n = 2;
  while (existingFiles.has(out.toLowerCase())) out = slugFrom(title).replace(/\.html$/, '-' + n++ + '.html');

  const raw = fs.readFileSync(full, 'utf8');
  const { s, hits } = clean(raw);
  gtagStripped += hits.gtag;
  adsStripped += hits.ads + hits.ins;

  if (!DRY) fs.writeFileSync(path.join(G, out), s);
  existingFiles.add(out.toLowerCase());
  existingTitles.add(key);
  added.push({ f: out, t: title });
  bytes += s.length;
}

console.log('  scanned        ' + files.length);
console.log('  added          ' + added.length + '   (' + (bytes / 1048576).toFixed(1) + ' MB)');
console.log('  skipped tiny   ' + skipped.tiny.length + (skipped.tiny.length ? '  ' + skipped.tiny.join(', ').slice(0, 90) : ''));
console.log('  skipped dupes  ' + (skipped.dupFile.length + skipped.dupTitle.length) +
  '   (' + skipped.dupFile.length + ' same filename, ' + skipped.dupTitle.length + ' same game)');
console.log('  trackers cut   ' + gtagStripped + ' analytics, ' + adsStripped + ' ad blocks');

if (DRY) { console.log(''); console.log('  dry run - nothing written'); process.exit(0); }

/* Keep the good titles so build-games.mjs does not re-guess them from the slug. */
const titles = {};
added.forEach((a) => { titles[a.f] = a.t; });
const titlesPath = path.join(G, 'arcady-titles.json');
const prev = fs.existsSync(titlesPath) ? JSON.parse(fs.readFileSync(titlesPath, 'utf8')) : {};
fs.writeFileSync(titlesPath, JSON.stringify({ ...prev, ...titles }, null, 1));

const merged = index.concat(added).sort((a, b) => a.t.localeCompare(b.t));
fs.writeFileSync(INDEX, JSON.stringify(merged));
console.log('  index.json     ' + index.length + ' -> ' + merged.length);
