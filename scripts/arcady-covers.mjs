/* Pulls cover art for the imported Arcady games.
 *
 * The zip shipped no images - Arcady's own page builds each cover at runtime,
 * in one of two ways:
 *
 *   <img src="https://cdn.jsdelivr.net/gh/freebuisness/covers@main/205.png">
 *   <img src="data:image/jpeg;base64,...">              (embedded in the page)
 *
 * So the art is recoverable, but only by reading its games.html: that is the
 * only place the game/cover pairing exists. Covers are copied here rather than
 * hotlinked - a jsdelivr dependency on every tile is a request to someone
 * else's CDN per game, and one more thing a school filter can break.
 *
 * Matching is by squashed title, because the filenames differ between their
 * listing and the files in the zip.
 *
 * Usage: node scripts/arcady-covers.mjs <path-to-games.html> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!SRC || !fs.existsSync(SRC)) {
  console.error('  pass the path to Arcady games.html');
  process.exit(1);
}

const OUT_DIR = 'public/g/covers';
const INDEX = 'public/g/index.json';
const MAP = 'public/g/covers.json';

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const html = fs.readFileSync(SRC, 'utf8');

/* Each tile is one <a class="card"> holding an <img> and a .title. */
const tiles = [...html.matchAll(/<a\b[^>]*class="card"[\s\S]{0,400000}?<\/a>/g)].map((m) => m[0]);
console.log('  tiles found: ' + tiles.length);

const entries = [];
for (const t of tiles) {
  const img = (t.match(/<img\b[^>]*src="([^"]+)"/) || [])[1];
  const title = (t.match(/<div class="title">([^<]*)<\/div>/) || [])[1];
  if (!img || !title) continue;
  entries.push({ title: title.trim(), img });
}
console.log('  with a title and an image: ' + entries.length);

const cdn = entries.filter((e) => e.img.startsWith('http')).length;
const inline = entries.filter((e) => e.img.startsWith('data:')).length;
console.log('    from the cdn:   ' + cdn);
console.log('    embedded inline:' + inline);

/* Match against the library by squashed title. */
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const byTitle = new Map();
for (const g of index) byTitle.set(norm(g.t), g);

const matched = [];
for (const e of entries) {
  const g = byTitle.get(norm(e.title));
  if (g) matched.push({ file: g.f, title: g.t, img: e.img });
}
/* One cover per game; the listing repeats some. */
const seen = new Set();
const unique = matched.filter((m) => (seen.has(m.file) ? false : (seen.add(m.file), true)));

console.log('');
console.log('  matched to your library: ' + unique.length + ' of ' + index.length + ' games');
console.log('    arcady imports: ' + unique.filter((m) => m.file.startsWith('ar')).length);
console.log('    older entries:  ' + unique.filter((m) => !m.file.startsWith('ar')).length);

if (DRY) {
  console.log('');
  unique.slice(0, 10).forEach((m) =>
    console.log('    ' + m.file.padEnd(34) + (m.img.startsWith('data:') ? '[inline]' : m.img.slice(-14))));
  console.log('');
  console.log('  dry run - nothing downloaded');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const map = fs.existsSync(MAP) ? JSON.parse(fs.readFileSync(MAP, 'utf8')) : {};
let saved = 0, failed = 0, skipped = 0;

for (const m of unique) {
  const stem = m.file.replace(/\.html?$/i, '');
  if (map[m.file]) { skipped++; continue; }

  try {
    if (m.img.startsWith('data:')) {
      const mm = m.img.match(/^data:image\/([a-z]+);base64,(.+)$/i);
      if (!mm) { failed++; continue; }
      const ext = mm[1].toLowerCase() === 'jpeg' ? 'jpg' : mm[1].toLowerCase();
      const file = stem + '.' + ext;
      fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(mm[2], 'base64'));
      map[m.file] = 'covers/' + file;
      saved++;
    } else {
      const r = await fetch(m.img, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { failed++; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) { failed++; continue; }
      const ext = path.extname(new URL(m.img).pathname).slice(1) || 'png';
      const file = stem + '.' + ext;
      fs.writeFileSync(path.join(OUT_DIR, file), buf);
      map[m.file] = 'covers/' + file;
      saved++;
    }
  } catch {
    failed++;
  }
  if ((saved + failed) % 50 === 0) process.stdout.write('    ' + saved + ' saved...\n');
}

fs.writeFileSync(MAP, JSON.stringify(map, null, 1));
console.log('');
console.log('  saved ' + saved + ', already had ' + skipped + ', failed ' + failed);
console.log('  covers.json now maps ' + Object.keys(map).length + ' games');
