/* Fetches EmulatorJS and points the ROM games at it.
 *
 * 70 of the imported games are a ROM plus a one-page loader that expects
 * EmulatorJS at the site root:
 *
 *   EJS_pathtodata = "../../storage/emulatorjs/data/"
 *
 * From /g/<game>/index.html that resolves to /storage/, which does not exist
 * here - the collection they came from shipped the games but not the emulator,
 * so every one of them renders black. Selenite ships it, so it is copied to
 * /g/storage/emulatorjs and the games are re-pointed one level shallower.
 *
 * Downloaded file by file rather than through git: partial clones kept either
 * fetching nothing or tripping over a path Windows cannot create.
 *
 * Usage: node scripts/get-emulatorjs.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const REPO = 'selenite-cc/selenite-old';
const BRANCH = 'main';
const OUT = 'public/g/storage/emulatorjs';

const tree = await (await fetch('https://api.github.com/repos/' + REPO + '/git/trees/' + BRANCH + '?recursive=1')).json();
if (!tree.tree) { console.error('  could not read the repo tree'); process.exit(1); }

const files = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith('emulatorjs/'));
const total = files.reduce((n, f) => n + (f.size || 0), 0);
console.log('  files: ' + files.length + '  (' + (total / 1048576).toFixed(1) + ' MB)');
if (DRY) { console.log('  dry run - nothing downloaded'); process.exit(0); }

let done = 0, failed = 0, bytes = 0;
const queue = files.slice();

async function worker() {
  for (;;) {
    const f = queue.shift();
    if (!f) return;
    /* emulatorjs/data/x -> <OUT>/data/x */
    const rel = f.path.replace(/^emulatorjs\//, '');
    const dst = path.join(OUT, rel);
    if (fs.existsSync(dst) && fs.statSync(dst).size === f.size) { done++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const url = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + f.path.split('/').map(encodeURIComponent).join('/');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) { failed++; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dst, buf);
      bytes += buf.length;
      done++;
    } catch { failed++; }
  }
}
await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

console.log('  downloaded: ' + done + '  failed: ' + failed + '  (' + (bytes / 1048576).toFixed(1) + ' MB)');
console.log('  loader.js present: ' + fs.existsSync(path.join(OUT, 'data/loader.js')));

/* Re-point the games: ../../storage/ is the site root, ../storage/ is /g/. */
const dirs = fs.readdirSync('public/g', { withFileTypes: true }).filter((d) => d.isDirectory());
let patched = 0;
for (const d of dirs) {
  const p = path.join('public/g', d.name, 'index.html');
  if (!fs.existsSync(p)) continue;
  let h;
  try { h = fs.readFileSync(p, 'utf8'); } catch { continue; }
  if (!h.includes('../../storage/')) continue;
  const out = h.split('../../storage/').join('../storage/');
  fs.writeFileSync(p, out);
  patched++;
}
console.log('  games re-pointed: ' + patched);
