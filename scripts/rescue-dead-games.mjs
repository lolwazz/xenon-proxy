/* Replaces dead game stubs with the self-hosted copy from seraph or selenite.
 *
 * Some games marked not-working are only broken because the version in the
 * library is a stub pointing at a host that dropped the files. The same game
 * exists as real files in a collection that was already scanned - it was
 * skipped at import time precisely because the library "already had" it.
 *
 * Downloading that copy and repointing the index entry turns a dead tile back
 * into a playable game. The old stub is left on disk but nothing links to it.
 *
 * Usage: node scripts/rescue-dead-games.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DIR = 'public/g';
const SP = 'C:/Users/mooma/AppData/Local/Temp/claude/C--Users-mooma-Downloads-fd/28213aad-261a-4575-ad14-8c0ce5d60f7d/scratchpad';

const REPOS = {
  seraph: { repo: 'gmshelf/seraph', branch: 'main', prefix: 'seraph/' },
  selenite: { repo: 'selenite-cc/selenite-old', branch: 'main', prefix: '' },
};

const list = JSON.parse(fs.readFileSync(SP + '/rescuable.json', 'utf8'));
console.log('  candidates: ' + list.length);

/* One tree per repo, reused across every game from it. */
const trees = {};
for (const key of Object.keys(REPOS)) {
  const r = REPOS[key];
  const t = await (await fetch('https://api.github.com/repos/' + r.repo + '/git/trees/' + r.branch + '?recursive=1')).json();
  trees[key] = (t.tree || []).filter((e) => e.type === 'blob' && !/[?:*<>"|]/.test(e.path));
}

const plan = [];
for (const g of list) {
  const r = REPOS[g.src];
  if (!r) continue;
  const root = r.prefix + g.slug + '/';
  const files = trees[g.src].filter((e) => e.path.startsWith(root));
  if (!files.length) { console.log('    no files found for ' + g.src + '/' + g.slug); continue; }
  if (!files.some((e) => /\/index\.html?$/i.test(e.path))) {
    console.log('    no index.html in ' + g.src + '/' + g.slug + ' - skipped');
    continue;
  }
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  plan.push({ ...g, root, files, bytes });
}

const total = plan.reduce((n, p) => n + p.bytes, 0);
console.log('  rescuable with real files: ' + plan.length
  + '  (' + (total / 1048576).toFixed(1) + ' MB)');
plan.sort((a, b) => b.bytes - a.bytes).slice(0, 6)
  .forEach((p) => console.log('    ' + (p.bytes / 1048576).toFixed(1).padStart(7) + ' MB  ' + p.title));
if (DRY) { console.log('  dry run - nothing downloaded'); process.exit(0); }

const HOSTS = /googletagmanager\.com|google-analytics\.com|hotjar|clarity\.ms|doubleclick|gtag\/js/i;
const BODY = /\bdataLayer\b|\bgtag\s*\(/;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const clean = (h) => h.replace(SCRIPT, (w, a, b) => {
  if (HOSTS.test(a)) return '';
  if (!a.includes('src') && BODY.test(b) && b.length <= 2000) return '';
  return w;
});

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const covers = JSON.parse(fs.readFileSync(path.join(DIR, 'covers.json'), 'utf8'));
let done = 0, failed = 0;

for (const p of plan) {
  const r = REPOS[p.src];
  let ok = true;
  for (const f of p.files) {
    /* seraph/flappy/x -> flappy/x ; selenite keeps its own top folder */
    const rel = f.path.slice(r.prefix.length);
    const dst = path.join(DIR, rel);
    if (fs.existsSync(dst) && fs.statSync(dst).size === f.size) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      const res = await fetch('https://raw.githubusercontent.com/' + r.repo + '/' + r.branch + '/'
        + f.path.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(180000) });
      if (!res.ok) { ok = false; break; }
      let buf = Buffer.from(await res.arrayBuffer());
      if (/\.html?$/i.test(rel)) {
        const t = buf.toString('utf8');
        const c = clean(t).split('../../storage/').join('../storage/');
        if (c !== t) buf = Buffer.from(c, 'utf8');
      }
      fs.writeFileSync(dst, buf);
    } catch { ok = false; break; }
  }
  if (!ok) { failed++; console.log('    failed: ' + p.title); continue; }

  const entry = index.find((g) => g.f === p.file);
  if (entry) {
    const oldCover = covers[entry.f];
    entry.f = p.slug + '/index.html';
    delete entry.d;
    if (oldCover) { covers[entry.f] = oldCover; }
  }
  done++;
  console.log('    rescued: ' + p.title + '  -> ' + p.slug + '/index.html');
}

fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index));
fs.writeFileSync(path.join(DIR, 'covers.json'), JSON.stringify(covers, null, 1));

console.log('');
console.log('  rescued: ' + done + '   failed: ' + failed);
console.log('  still marked not-working: ' + index.filter((g) => g.d).length);
