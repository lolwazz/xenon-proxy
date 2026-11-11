/* Repairs game wrappers whose iframe src was corrupted upstream.
 *
 * ckv shipped a batch of files where a find-replace spliced the game's title
 * into the path: src="baldisbasics2.html's Basics.html" instead of
 * src="baldisbasics2.html". The target file is there; only the reference is
 * wrong, so the game loads a 404 and shows black.
 *
 * Everything after the first .html is dropped, and only when the trimmed name
 * actually exists on disk - otherwise the file is left alone rather than
 * guessed at.
 *
 * Usage: node scripts/fix-iframe-src.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'public/g';
const DRY = process.argv.includes('--dry');

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const SRC = /<iframe[^>]*\ssrc="([^"]*)"/i;

let fixed = 0, skipped = 0;
const notes = [];

for (const g of index) {
  const p = path.join(DIR, g.f);
  if (!fs.existsSync(p)) continue;
  let html;
  try { html = fs.readFileSync(p, 'utf8'); } catch { continue; }

  const m = html.match(SRC);
  if (!m) continue;
  const bad = m[1];
  if (!bad || /^(https?:|about:)/i.test(bad)) continue;

  const target = path.join(DIR, bad.replace(/^\.?\//, '').split('?')[0]);
  if (fs.existsSync(target)) continue;

  const good = bad.replace(/(\.html).*$/i, '$1');
  if (good === bad) { skipped++; continue; }
  if (!fs.existsSync(path.join(DIR, good.replace(/^\.?\//, '')))) { skipped++; continue; }

  /* Plain string swap of the whole attribute - no pattern building, so a
     title full of apostrophes cannot turn into syntax. */
  const next = html.replace('src="' + bad + '"', 'src="' + good + '"');
  if (next === html) { skipped++; continue; }

  if (!DRY) fs.writeFileSync(p, next);
  fixed++;
  if (notes.length < 8) notes.push(g.f + '  "' + bad + '" -> "' + good + '"');
}

console.log('  repaired: ' + fixed);
console.log('  left alone (no valid target to point at): ' + skipped);
notes.forEach((n) => console.log('    ' + n));
if (DRY) console.log('  dry run - nothing written');
