/**
 * Copies the Retro Bowl multiplayer mod into Xenon's games.
 *
 * The game is one self-contained HTML file (JSZip plus the game, unpacked in
 * the browser) built by a separate project. It is copied byte for byte -
 * never edited here - to public/g/retrobowlmultiplayer.html, which the proxy
 * serves as a static file and the All games page opens in its game frame.
 *
 * Run it again whenever that project rebuilds the file:
 *
 *   node scripts/update-retro-bowl.mjs ["C:/path/to/index-overdrive.html"]
 *
 * It is live as soon as it finishes: both sites load games from the proxy,
 * so there is nothing to deploy. It also makes sure the game is first in the
 * All list (marked new) with its cover - scripts/build-games.mjs rebuilds
 * index.json from filenames and would drop both, so re-run this after it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = path.join(ROOT, 'public', 'g');
const SRC = process.argv[2] || 'C:/Users/mooma/Downloads/New folder (6)/index-overdrive.html';
const FILE = 'retrobowlmultiplayer.html';
const TITLE = 'Retro Bowl Multiplayer';
const COVER = 'covers-t/retrobowlmultiplayer.webp';

const buf = fs.readFileSync(SRC);
/* A half-written or wrong file would replace a working game, so check it
   looks like the build before touching anything. */
const head = buf.subarray(0, 4096).toString('utf8');
if (!/^\s*<!doctype html/i.test(head)) throw new Error('not an HTML file: ' + SRC);
if (!head.includes('JSZip')) throw new Error('does not look like the self-unpacking build (no JSZip): ' + SRC);
if (buf.length < 1024 * 1024) throw new Error('only ' + buf.length + ' bytes - an unfinished build?');

const dest = path.join(G, FILE);
fs.writeFileSync(dest + '.tmp', buf);
fs.renameSync(dest + '.tmp', dest);

if (!fs.existsSync(path.join(G, COVER))) console.warn('warning: cover missing at public/g/' + COVER);

/* First in the list, marked new. Rewritten in the file's own compact form. */
const idxPath = path.join(G, 'index.json');
const index = JSON.parse(fs.readFileSync(idxPath, 'utf8')).filter((g) => g.f !== FILE);
/* tr: the game keeps buttons (Sign in) in the top-right corner, so the games
   page moves its own fullscreen button to the left for it. */
index.unshift({ f: FILE, t: TITLE, n: 1, tr: 1 });
fs.writeFileSync(idxPath, JSON.stringify(index));

const covPath = path.join(G, 'covers.json');
const covers = JSON.parse(fs.readFileSync(covPath, 'utf8'));
if (covers[FILE] !== COVER) { covers[FILE] = COVER; fs.writeFileSync(covPath, JSON.stringify(covers)); }

const md5 = crypto.createHash('md5').update(buf).digest('hex');
console.log(`copied ${(buf.length / 1048576).toFixed(1)} MB -> public/g/${FILE}  (md5 ${md5})`);
console.log(`listed first in index.json as "${TITLE}", cover ${COVER}`);
