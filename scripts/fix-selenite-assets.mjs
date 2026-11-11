/* Gives the selenite games the shared assets they expect.
 *
 * 52 of them load "/js/all.js" - an absolute path, meaning the site root,
 * which on this server is the WordPress site rather than the game library. The
 * files live at the root of the selenite repo, so they are fetched into
 * public/g and the references are rewritten one level relative instead:
 * /js/all.js -> ../js/all.js, which from /g/<game>/index.html lands on
 * /g/js/all.js.
 *
 * public/g/js already holds a file from the ckv import, so anything that would
 * overwrite an existing name is reported rather than clobbered.
 *
 * Usage: node scripts/fix-selenite-assets.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const REPO = 'selenite-cc/selenite-old';
const BRANCH = 'main';
const DST = 'public/g';
const SP = 'C:/Users/mooma/AppData/Local/Temp/claude/C--Users-mooma-Downloads-fd/28213aad-261a-4575-ad14-8c0ce5d60f7d/scratchpad';

const tree = await (await fetch('https://api.github.com/repos/' + REPO + '/git/trees/' + BRANCH + '?recursive=1')).json();
if (!tree.tree) { console.error('  could not read the repo tree'); process.exit(1); }

const shared = tree.tree.filter((e) => e.type === 'blob' && /^(js|img)\//.test(e.path) && !/[?:*<>"|]/.test(e.path));
console.log('  shared files: ' + shared.length + '  ('
  + (shared.reduce((n, f) => n + (f.size || 0), 0) / 1048576).toFixed(1) + ' MB)');

const clashes = shared.filter((f) => fs.existsSync(path.join(DST, f.path)));
if (clashes.length) console.log('  already present, left as they are: ' + clashes.map((c) => c.path).join(', '));

let got = 0, failed = 0;
if (!DRY) {
  for (const f of shared) {
    const dst = path.join(DST, f.path);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      const r = await fetch('https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/'
        + f.path.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(90000) });
      if (!r.ok) { failed++; continue; }
      fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
      got++;
    } catch { failed++; }
  }
}
console.log('  downloaded: ' + got + '  failed: ' + failed);

/* Re-point only the selenite folders, so nothing else is touched. */
const want = JSON.parse(fs.readFileSync(SP + '/selenite-new.json', 'utf8'));
let patched = 0, refs = 0;
for (const g of want) {
  const p = path.join(DST, g.slug, 'index.html');
  if (!fs.existsSync(p)) continue;
  let h;
  try { h = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const before = h;
  for (const dir of ['js', 'img', 'css']) {
    h = h.split('src="/' + dir + '/').join('src="../' + dir + '/');
    h = h.split('href="/' + dir + '/').join('href="../' + dir + '/');
  }
  if (h !== before) {
    refs += (before.match(/(?:src|href)="\/(js|img|css)\//g) || []).length;
    if (!DRY) fs.writeFileSync(p, h);
    patched++;
  }
}
console.log('  games re-pointed: ' + patched + '  (' + refs + ' references)');
if (DRY) console.log('  dry run - nothing written');
