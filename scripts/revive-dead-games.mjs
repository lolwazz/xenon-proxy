/* Points dead games at the repo they always came from, via GitHub directly.
 *
 * Most of the not-working games are not gone at all. Their <base href> pins a
 * jsDelivr url at an old commit, and jsDelivr answers 403 once that commit is
 * unreachable - or once the file is over its 20 MB cap. The repository is
 * still there.
 *
 * Fetching the same path from raw.githubusercontent at the repo's current
 * default branch sidesteps both, and routing it through /cdn keeps the browser
 * talking only to this origin. Each candidate was verified to actually answer
 * before it got into the plan, so nothing here is speculative.
 *
 * Usage: node scripts/revive-dead-games.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DIR = 'public/g';
const SP = 'C:/Users/mooma/AppData/Local/Temp/claude/C--Users-mooma-Downloads-fd/28213aad-261a-4575-ad14-8c0ce5d60f7d/scratchpad';

const plan = JSON.parse(fs.readFileSync(SP + '/revive-plan.json', 'utf8'));
console.log('  verified recoverable: ' + plan.length);

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const byFile = new Map(index.map((g) => [g.f, g]));

let rewritten = 0, missed = 0;
for (const p of plan) {
  const file = path.join(DIR, p.file);
  if (!fs.existsSync(file)) { missed++; continue; }
  let h;
  try { h = fs.readFileSync(file, 'utf8'); } catch { missed++; continue; }
  const out = h.split('href="' + p.old + '"').join('href="' + p.base + '"');
  if (out === h) { missed++; continue; }
  if (!DRY) fs.writeFileSync(file, out);
  const entry = byFile.get(p.file);
  if (entry) delete entry.d;
  rewritten++;
}

if (!DRY) fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index));

console.log('  rewritten to /cdn/raw.githubusercontent: ' + rewritten);
console.log('  could not rewrite:                       ' + missed);
console.log('  still marked not-working:                ' + index.filter((g) => g.d).length);
console.log('  playable:                                ' + index.filter((g) => !g.d).length);
if (DRY) console.log('  dry run - nothing written');
