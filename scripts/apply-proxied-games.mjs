/* Broken games replaced with proxied links (2026-11-07).
 *
 * public/g/proxied-games.json maps a game file that no longer works to
 *   {u, t}      a working build of the same game elsewhere (6xclassroom's
 *               builds on bestgradex.com), which the All/Popular page opens
 *               through the proxy like the GameMonetize games, or
 *   {dupOf: f}  another copy of a game already replaced: dropped from the
 *               lists (kept in index-hidden.json) so it shows up once.
 * The tile keeps its file name, so covers, favourites and "recently played"
 * still find it.
 *
 * scripts/build-games.mjs rebuilds index.json from file names and loses this,
 * so run this after it (like update-retro-bowl.mjs). Safe to run twice.
 *
 * Usage: node scripts/apply-proxied-games.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const G = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'public', 'g');
const DRY = process.argv.includes('--dry');
const map = JSON.parse(fs.readFileSync(path.join(G, 'proxied-games.json'), 'utf8'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(G, f), 'utf8'));
const hiddenFile = path.join(G, 'index-hidden.json');
const hidden = fs.existsSync(hiddenFile) ? read('index-hidden.json') : [];
const hiddenSet = new Set(hidden.map((g) => g.f));

function apply(list) {
  let set = 0, dropped = 0;
  const out = [];
  for (const g of list) {
    const m = map[g.f];
    if (!m) { out.push(g); continue; }
    if (m.dupOf) {
      dropped++;
      if (!hiddenSet.has(g.f)) { hidden.push({ ...g, hiddenWhy: 'copy of ' + m.dupOf + ' (proxied-games.json)' }); hiddenSet.add(g.f); }
      continue;
    }
    if (g.u !== m.u || g.t !== m.t) set++;
    out.push({ ...g, t: m.t, u: m.u });
  }
  return { out, set, dropped };
}

for (const f of ['index.json', 'popular.json']) {
  const r = apply(read(f));
  console.log(`${f}: ${r.set} pointed at a proxied build, ${r.dropped} duplicate copies dropped`);
  if (!DRY) fs.writeFileSync(path.join(G, f), JSON.stringify(r.out));
}
if (!DRY) fs.writeFileSync(hiddenFile, JSON.stringify(hidden));
