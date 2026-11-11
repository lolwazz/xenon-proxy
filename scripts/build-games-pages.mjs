// Builds the games as a Cloudflare Pages project, so they are served from
// Cloudflare instead of this PC's upload.
//
//   node scripts/build-games-pages.mjs D:/xenon-build/games https://proxy.zpack.beauty
//   cd D:/xenon-build/games
//   npx wrangler pages deploy public --project-name zpack-games --branch main
//
// public/ holds the files at the same /g/... paths the proxy uses, so every
// relative link inside a game keeps working. functions/ replaces the two
// proxy routes games depend on: /cdn/<host>/<path> (a fetch-through for
// jsDelivr and GitHub) and /flash/<file>.swf (the Ruffle wrapper page).
// Files over Pages' 25 MB limit stay on the proxy: _redirects sends just
// those there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || '');
const PROXY = String(process.argv[3] || '').replace(/\/+$/, '');
if (!process.argv[2] || !/^https:\/\//.test(PROXY)) throw new Error('usage: build-games-pages.mjs <outDir> <https://proxy-origin>');

const SRC = path.join(ROOT, 'public', 'g');
const PUB = path.join(OUT, 'public');
const FN = path.join(OUT, 'functions');
const MAX = 25 * 1024 * 1024;
// Console ROMs and the archives they ship in are not published to Pages.
// They stay on the proxy, reached through the same redirects as the
// oversized files.
const KEEP_ON_PROXY = /\.(nds|gba|gbc|gb|nes|sfc|smc|n64|z64|v64|iso|cso|3ds|cia|gen|md|sms|gg|pce|psx|cue|chd|xci|nsp|wbfs|gcm|rvz|zip|7z|rar)$/i;
const FILE_LIMIT = 20000;

/* "Watch me play" (2026-11-07): each game page's copy gets xn-watch.js; the
   originals in public/g are never touched. */
import { withWatch } from '../backend/watch-tag.js';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(PUB, { recursive: true });

let files = 0, html = 0, bytes = 0;
const big = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
    const src = path.join(dir, e.name);
    const r = rel + '/' + e.name;
    if (e.isDirectory()) { walk(src, r); continue; }
    const st = fs.statSync(src);
    if (st.size > MAX || KEEP_ON_PROXY.test(e.name)) { big.push(r); continue; }
    const dest = path.join(PUB, 'g', r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (/\.html?$/i.test(e.name)) {
      html++;
      fs.writeFileSync(dest, withWatch(fs.readFileSync(src, 'latin1')), 'latin1');
    } else {
      fs.copyFileSync(src, dest);
    }
    files++;
    bytes += st.size;
  }
})(SRC, '');

// Ruffle, for the Flash games.
const RUFFLE = path.join(ROOT, 'node_modules', '@ruffle-rs', 'ruffle');
fs.cpSync(RUFFLE, path.join(PUB, 'ruffle'), { recursive: true });
files += fs.readdirSync(path.join(PUB, 'ruffle'), { recursive: true }).length;

fs.copyFileSync(path.join(ROOT, 'scripts', 'games-pages', 'save-import.html'), path.join(PUB, 'save-import.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'save-export.html'), path.join(PUB, 'save-export.html'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'games-pages', 'xn-watch.js'), path.join(PUB, 'xn-watch.js'));
files += 3;

const enc = (r) => r.split('/').map(encodeURIComponent).join('/');
// Pages will not match a rule written with %-escapes, so a file whose name
// needs them (spaces, commas, brackets) sends its whole folder to the proxy.
const exact = new Set(), folders = new Set();
for (const r of big) {
  if (enc(r) === r) { exact.add(r); continue; }
  let dir = path.posix.dirname(r);
  while (dir !== '/' && enc(dir) !== dir) dir = path.posix.dirname(dir);
  if (dir === '/') throw new Error('cannot redirect ' + r);
  folders.add(dir);
}
for (const r of exact) { for (const d of folders) { if (r.startsWith(d + '/')) exact.delete(r); } }
const redirects = [
  '# Over the 25 MB file limit, or a console ROM: served by the proxy instead.',
  ...[...exact].map((r) => '/g' + r + ' ' + PROXY + '/g' + r + ' 302'),
  ...[...folders].map((d) => '/g' + d + '/* ' + PROXY + '/g' + d + '/:splat 302'),
  // Games the proxy builds on the fly in server.js, with no file in public/g
  // to copy - without these they are a plain 404 on the games site.
  '# Served by a route in server.js, not a file.',
  '/g/retrobowlmodded.html ' + PROXY + '/g/retrobowlmodded.html 302',
  '/g/retrobowlmodded/* ' + PROXY + '/g/retrobowlmodded/:splat 302',
  '# Proxy features a few games call by absolute path.',
  ...['uv', 'scram', 'baremux', 'epoxy', 'libcurl', 'baremod', 'api', 'img'].map((p) => '/' + p + '/* ' + PROXY + '/' + p + '/:splat 302'),
];
const dynamic = redirects.filter((l) => l.includes('*')).length;
if (dynamic > 100) throw new Error(dynamic + ' folder redirects - Pages allows 100');
fs.writeFileSync(path.join(PUB, '_redirects'), redirects.join('\n') + '\n');

fs.writeFileSync(path.join(PUB, '_headers'), [
  '/g/*',
  '  Cache-Control: public, max-age=86400, stale-while-revalidate=604800',
  '  Access-Control-Allow-Origin: *',
  '/ruffle/*',
  '  Cache-Control: public, max-age=604800',
  '/save-import.html',
  '  Cache-Control: no-cache',
  '/save-export.html',
  '  Cache-Control: no-cache',
  '/xn-watch.js',
  '  Cache-Control: public, max-age=3600',
  '',
].join('\n'));

// Functions only run for these paths; every other request is a plain file.
fs.writeFileSync(path.join(PUB, '_routes.json'), JSON.stringify({ version: 1, include: ['/cdn/*', '/flash/*'], exclude: [] }));

fs.cpSync(path.join(ROOT, 'scripts', 'games-pages', 'functions'), FN, { recursive: true });

console.log(`files: ${files} (limit ${FILE_LIMIT})  game pages: ${html}  size: ${(bytes / 1e9).toFixed(2)} GB`);
console.log(`left on the proxy (over 25 MB or a ROM): ${big.length}`);
if (files > FILE_LIMIT) throw new Error('over the Pages file limit');
