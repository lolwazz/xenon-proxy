/* Sorts out the games that are not hosted here.
 *
 * Several hundred of the imported pages are stubs: a <base href> pointing at
 * jsDelivr or githack, and every asset loaded from there. Two separate
 * problems come out of that:
 *
 *   - some of those urls are dead. The repo was deleted or renamed, so the
 *     game cannot load for anyone, anywhere. Nothing to fix; the tile just
 *     needs to say so instead of doing nothing when clicked.
 *   - the rest are alive but on a domain the school decides about separately.
 *     Rewriting the base to /cdn/<host>/... sends them through this server, so
 *     the browser only ever talks to one host.
 *
 * Only hosts the /cdn route allows are rewritten. Google's own domains are
 * left alone - they are rarely blocked and not in the allowlist.
 *
 * Usage: node scripts/fix-external-games.mjs [--dry] [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const li = process.argv.indexOf('--limit');
const LIMIT = li > -1 ? Number(process.argv[li + 1]) : Infinity;

const DIR = 'public/g';
const PROXYABLE = [
  /^cdn\.jsdelivr\.net$/i,
  /^(raw|bb)cdn\.githack\.com$/i,
  /^cdn\.statically\.io$/i,
  /^raw\.githubusercontent\.com$/i,
];

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));

/* Collect every game with an external base, and the first asset it asks for -
 * that url is what tells us whether the source is still there. */
const jobs = [];
for (const g of index) {
  const p = path.join(DIR, g.f);
  if (!fs.existsSync(p)) continue;
  let h;
  try { h = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const b = h.match(/<base[^>]*href="(https?:\/\/[^"]+)"/i);
  if (!b) continue;
  let base;
  try { base = new URL(b[1]); } catch { continue; }
  /* Probe a real file, never the directory. jsDelivr answers 403 to a bare
     folder, which reads as "gone" when the game is perfectly fine - that
     mistake marked a few hundred working games as broken. A game with no
     relative asset to test is left unjudged rather than guessed at. */
  const rel = [...h.matchAll(/(?:src|href)="(?!https?:|\/\/|data:|#)([^"]+)"/gi)]
    .map((m) => m[1])
    .find((u) => /\.(js|css|json|png|jpe?g|webp|wasm|unityweb|data|mem|html?)(\?|$)/i.test(u));
  if (!rel) { jobs.push({ entry: g, file: p, baseRaw: b[1], base, probe: null }); continue; }
  let probe;
  try { probe = new URL(rel, base.href).href; } catch { continue; }
  jobs.push({ entry: g, file: p, baseRaw: b[1], base, probe });
}
console.log('  games with an external base: ' + jobs.length);

const work = jobs.slice(0, LIMIT === Infinity ? jobs.length : LIMIT);

/* Check them in parallel, but not so many at once that a CDN starts refusing. */
let checked = 0;
async function check(j) {
  if (!j.probe) { j.alive = null; j.status = 'untested'; checked++; return; }
  try {
    const r = await fetch(j.probe, { signal: AbortSignal.timeout(30000) });
    j.alive = r.status >= 200 && r.status < 400;
    j.status = r.status;
  } catch (e) {
    j.alive = false;
    j.status = e.name === 'TimeoutError' ? 'timeout' : 'error';
  }
  checked++;
  if (checked % 50 === 0) process.stdout.write('    checked ' + checked + '/' + work.length + '\n');
}
const queue = work.slice();
await Promise.all(Array.from({ length: 10 }, async () => {
  for (;;) { const j = queue.shift(); if (!j) return; await check(j); }
}));

const dead = work.filter((j) => j.alive === false);
const alive = work.filter((j) => j.alive === true);
const unknown = work.filter((j) => j.alive === null);
console.log('');
console.log('  alive: ' + alive.length + '   dead: ' + dead.length
  + '   no file to test: ' + unknown.length + ' (left as they are)');

/* Games whose probe failed are left as they are and not marked: the probe
   flagged games that play fine (2026-10-27), and a wrong "not working" stamp
   is worse than none. They are listed so they can be checked by hand. */
let marked = 0, rewritten = 0, leftAlone = 0;
for (const j of dead) { console.log('  probe failed (left alone): ' + j.entry.f); marked++; }
for (const j of alive.concat(unknown)) {
  if (j.entry.d) delete j.entry.d;
  if (!PROXYABLE.some((re) => re.test(j.base.hostname))) { leftAlone++; continue; }
  let h = fs.readFileSync(j.file, 'utf8');
  const next = '/cdn/' + j.base.hostname + j.base.pathname;
  const out = h.split('href="' + j.baseRaw + '"').join('href="' + next + '"');
  if (out === h) continue;
  if (!DRY) fs.writeFileSync(j.file, out);
  rewritten++;
}

if (!DRY) fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index));

console.log('  probe failed:       ' + marked);
console.log('  rewritten to /cdn:  ' + rewritten);
console.log('  left on their host: ' + leftAlone + '  (not in the allowlist - google domains)');
console.log('');
const byStatus = {};
for (const j of dead) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
console.log('  why the dead ones failed: '
  + Object.entries(byStatus).map(([k, v]) => v + 'x ' + k).join(', '));
if (DRY) console.log('  dry run - nothing written');
