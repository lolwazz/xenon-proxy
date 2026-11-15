/* Imports the second UGS pack (bubbls/ugs-singlefile, the repo behind the
 * "Orbit Game Stash" page) into public/g/ugs2/ (2026-11-15).
 *
 * Only games not already in the library are taken; games we already have
 * keep our copies (several were repaired by revive/rescue scripts). Left out
 * on purpose: casino games, in-browser web browsers that route traffic through
 * third-party proxies, and the 28 games hidden for dead sources (the repo's
 * copies point at the same dead hosts). Analytics/ad tags are stripped the
 * same way as scripts/strip-trackers.mjs. ugs2/ is served by the proxy, not
 * copied to the games site (PROXY_FOLDERS in build-games-pages.mjs).
 *
 * Usage: node scripts/import-ugs2.mjs <staging folder with the downloaded files> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

const G = 'public/g';
const OUT = path.join(G, 'ugs2');
const SRC = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!SRC || !fs.existsSync(SRC)) throw new Error('usage: import-ugs2.mjs <staging folder> [--dry]');

/* not games, or not for this site */
const SKIP = new Set(['claviamasters.html', 'claviamastersbuggy.html', 'clhelios-offline.html', 'clhelios-offline (1).html',
  'clnautilusos.html', 'clnautilusos(1).html', 'clsandstone.html', 'clsandstone(1).html']);

const index = JSON.parse(fs.readFileSync(path.join(G, 'index.json'), 'utf8'));
const hidden = JSON.parse(fs.readFileSync(path.join(G, 'index-hidden.json'), 'utf8'));
const have = new Set(index.map((g) => path.basename(g.f).toLowerCase()));
const hid = new Set(hidden.map((g) => path.basename(g.f).toLowerCase()));

/* ---- analytics stripping (same rules as strip-trackers.mjs, plus ads) */
const HOSTS = /googletagmanager\.com|google-analytics\.com|hotjar|clarity\.ms|doubleclick|analytics\.js|gtag\/js|pagead2\.googlesyndication\.com|static\.cloudflareinsights\.com/i;
const BODY = /\bdataLayer\b|\bgtag\s*\(|adsbygoogle/;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
function strip(raw) {
  let n = 0;
  const out = raw.replace(SCRIPT, (whole, attrs, body) => {
    if (HOSTS.test(attrs)) { n++; return ''; }
    if (!/\bsrc\s*=/.test(attrs) && BODY.test(body) && body.length <= 2000) { n++; return ''; }
    return whole;
  });
  return { out, n };
}

/* ---- titles: same rules as build-games.mjs (copied; that file is a script) */
const WORDS = `geometry dash subway surfers slope retro bowl basketball stars
soccer tennis moto x3m happy wheels drift hunters cookie clicker among us
minecraft eaglercraft roblox fortnite shell shockers krunker bloxd io paper
tunnel rush stack ball run bullet bounce jump idle breakout tower defense
snow rider monkey mart drive mad temple duck life fireboy watergirl vex
madalin stunt cars papas pizzeria burger freezeria scooby doo super mario
sonic pacman tetris chess checkers solitaire poker blackjack bingo trivia
wordle crossword sudoku mahjong bubble shooter candy crush zombie shooter
sniper archer tank battle royale clash clicker simulator tycoon obby parkour
escape horror scary granny baldi rainbow friends poppy playtime fnaf five
nights freddy huggy wuggy skibidi toilet doors piggy adopt me jailbreak
murder mystery arsenal phantom forces bee swarm pet blade ball tower hell
speed run flappy bird crossy road doodle helix stickman fighting boxing
wrestling racing car bike truck parking simulator city builder farm cooking
dress up makeover puzzle match memory cards word search hangman quiz math
typing test aim trainer reaction time clicker cps counter strike doom quake
wolfenstein duke nukem pinball air hockey pool billiards darts bowling golf
mini putt baseball football hockey volleyball dodgeball kickball
pokemon emerald fortress runner motors aquapark sentry estate mirage
warfare fighter island rider master legend battle ninja pixel craft
`.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
const SAFE = WORDS.filter((w) => w.length >= 4);
function split(raw) {
  let s = raw; const out = []; let guard = 0;
  while (s.length && guard++ < 60) {
    const w = SAFE.find((x) => s.startsWith(x));
    if (w) { out.push(w); s = s.slice(w.length); continue; }
    let i = 1;
    while (i < s.length && !SAFE.some((x) => s.startsWith(x, i))) i++;
    out.push(s.slice(0, i)); s = s.slice(i);
  }
  return out;
}
const titleCase = (w) => (/^(io|ii|iii|iv|vs|3d|2d|fps|nfs|gta|fnaf|cps|lol|ny|nes|snes|gba)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
function toTitle(file) {
  let n = file.replace(/\.html$/i, '').replace(/\s*\(\d+\)$/, '');
  n = n.replace(/^cl(?=[A-Za-z0-9])/, '');
  if (/[A-Z_\- ]/.test(n.slice(1))) {
    const h = n.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return h.charAt(0).toUpperCase() + h.slice(1);
  }
  const nvn = n.match(/^(\d+v\d+)/);
  let lead = '';
  if (nvn) { lead = nvn[1]; n = n.slice(lead.length); } else { const d = n.match(/^\d+/); if (d) { lead = d[0]; n = n.slice(lead.length); } }
  let parts = split(n).filter(Boolean).map(titleCase);
  parts = parts.reduce((acc, w) => { if (acc.length && w.length === 1 && /[a-z]/i.test(w)) { acc[acc.length - 1] += w.toLowerCase(); return acc; } acc.push(w); return acc; }, []);
  return [lead, ...parts].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || file;
}

const files = fs.readdirSync(SRC).filter((f) => /\.html$/i.test(f));
let added = 0, skipped = 0, already = 0, stripped = 0, bytes = 0;
const entries = [];
if (!DRY) fs.mkdirSync(OUT, { recursive: true });
for (const f of files) {
  const k = f.toLowerCase();
  if (SKIP.has(k) || hid.has(k)) { skipped++; continue; }
  if (have.has(k)) { already++; continue; }
  const raw = fs.readFileSync(path.join(SRC, f), 'utf8');
  const { out, n } = strip(raw);
  if (n) stripped++;
  bytes += Buffer.byteLength(out);
  if (!DRY) fs.writeFileSync(path.join(OUT, f), out);
  entries.push({ f: 'ugs2/' + f, t: toTitle(f) });
  added++;
}
if (!DRY && entries.length) {
  const next = index.concat(entries).sort((a, b) => a.t.localeCompare(b.t, 'en', { numeric: true }));
  fs.writeFileSync(path.join(G, 'index.json'), JSON.stringify(next));
}
console.log({ added, alreadyHad: already, leftOut: skipped, trackersStripped: stripped, MB: Math.round(bytes / 1048576), dry: DRY });
console.log(entries.slice(0, 15).map((e) => '  ' + e.f + '  ->  ' + e.t).join('\n'));
