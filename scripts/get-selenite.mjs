/* Downloads the selenite game folders that are new to this library.
 *
 * Two git attempts failed: a sparse pattern for a file silently disabled cone
 * matching and dragged in the whole repo, and the repo contains
 * 'gdlite/image/loading.png?v=1', a name Windows cannot create, which aborts
 * any checkout that validates it. Fetching the blobs by url sidesteps both -
 * nothing outside the wanted list is ever touched.
 *
 * Usage: node scripts/get-selenite.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const REPO = 'selenite-cc/selenite-old';
const BRANCH = 'main';
const OUT = 'public/g';
const SP = 'C:/Users/mooma/AppData/Local/Temp/claude/C--Users-mooma-Downloads-fd/28213aad-261a-4575-ad14-8c0ce5d60f7d/scratchpad';

const want = new Set(JSON.parse(fs.readFileSync(SP + '/selenite-new.json', 'utf8')).map((g) => g.slug));
console.log('  folders wanted: ' + want.size);

const tree = await (await fetch('https://api.github.com/repos/' + REPO + '/git/trees/' + BRANCH + '?recursive=1')).json();
if (!tree.tree) { console.error('  could not read the repo tree'); process.exit(1); }

/* Skip anything Windows will refuse, rather than discovering it mid-run. */
const ILLEGAL = /[?:*<>"|]/;
const files = tree.tree.filter((e) => {
  if (e.type !== 'blob') return false;
  const top = e.path.split('/')[0];
  if (!want.has(top)) return false;
  if (ILLEGAL.test(e.path)) return false;
  return true;
});
const total = files.reduce((n, f) => n + (f.size || 0), 0);
console.log('  files: ' + files.length + '  (' + (total / 1048576).toFixed(1) + ' MB)');
if (DRY) { console.log('  dry run'); process.exit(0); }

let done = 0, failed = 0, bytes = 0, skipped = 0;
const queue = files.slice();
const failures = [];

async function worker() {
  for (;;) {
    const f = queue.shift();
    if (!f) return;
    const dst = path.join(OUT, f.path);
    if (fs.existsSync(dst) && fs.statSync(dst).size === f.size) { skipped++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const url = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/'
      + f.path.split('/').map(encodeURIComponent).join('/');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) { failed++; failures.push(f.path + ' ' + r.status); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dst, buf);
      bytes += buf.length; done++;
      if (done % 200 === 0) process.stdout.write('    ' + done + ' files...\n');
    } catch (e) { failed++; failures.push(f.path + ' ' + e.name); }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

console.log('  downloaded: ' + done + '  already had: ' + skipped + '  failed: ' + failed
  + '  (' + (bytes / 1048576).toFixed(1) + ' MB)');
failures.slice(0, 6).forEach((f) => console.log('    ' + f));
