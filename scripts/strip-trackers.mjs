/* Removes analytics from every game in public/g.
 *
 * These files come from several collections and each shipped its own tag, in
 * more than one shape - a src= tag, a tidy inline block, and a minified one
 * that starts with the function instead of the assignment. Matching on the
 * shape missed the last kind, so this matches on what a script *is*: any tag
 * whose source is a known analytics host, and any inline tag that talks to
 * dataLayer or gtag and is small enough to be a tag rather than a game.
 *
 * The size guard matters. A game bundle that happens to mention gtag should
 * not be deleted, so only short blocks are taken.
 *
 * Usage: node scripts/strip-trackers.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'public/g';
const DRY = process.argv.includes('--dry');
const MAX_INLINE = 2000;

const HOSTS = /googletagmanager\.com|google-analytics\.com|hotjar|clarity\.ms|doubleclick|analytics\.js|gtag\/js/i;
const BODY = /\bdataLayer\b|\bgtag\s*\(/;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
let touched = 0, removed = 0, keptBig = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
  if (!HOSTS.test(raw) && !BODY.test(raw)) continue;

  let hits = 0;
  const out = raw.replace(SCRIPT, (whole, attrs, body) => {
    if (HOSTS.test(attrs)) { hits++; return ''; }
    if (!attrs.includes('src') && BODY.test(body)) {
      if (body.length <= MAX_INLINE) { hits++; return ''; }
      keptBig++;
    }
    return whole;
  });

  if (hits) {
    removed += hits;
    touched++;
    if (!DRY) fs.writeFileSync(p, out);
  }
}

console.log('  files scanned:        ' + files.length);
console.log('  files cleaned:        ' + touched);
console.log('  script tags removed:  ' + removed);
console.log('  large blocks kept:    ' + keptBig + '  (too big to be a tag - left alone)');
if (DRY) console.log('  dry run - nothing written');
