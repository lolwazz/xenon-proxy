/* Builds public/themes/list.json from YouTube video ids, via the portal's own
 * music search (/api/music/search), which returns "yt<videoId>" for results.
 *
 * Playback is a hidden YouTube IFrame player rather than an <audio> element:
 * /api/music/play answers {provider:'youtube', embed:true} with no direct
 * audio url, so an iframe is the only way to hear these. That also means the
 * theme needs YouTube reachable - it will stay silent on a network that
 * blocks it.
 *
 * Nintendo menu music only - Wii, Wii U, Mii Channel and Mario Kart Wii.
 *
 * Usage: node scripts/build-theme-songs.mjs
 */
import fs from 'node:fs';

const API = process.env.XENON_API || 'http://127.0.0.1:8080';

const QUERIES = [
  'Wii Shop Channel Theme',
  'Mii Channel Theme',
  'Wii Menu Theme',
  'Wii U Menu Theme music',
  'Wii Sports Theme',
  'Wii Party Main Menu',
  'Mario Kart Wii Title Theme',
  'Wii Sports Resort Title Theme',
  'Wii Fit Plus Menu Theme',
  'Wii Play Menu Theme',
  'Wii Music Menu Theme',
  'Wii Photo Channel Theme',
  'Wii U Wara Wara Plaza Theme',
  'Nintendo 3DS Home Menu Theme',
  'Nintendo DS Menu Theme',
  'Nintendo Switch Home Menu Theme',
  'Animal Crossing Wild World Title Theme',
  'Animal Crossing New Leaf Main Theme',
  'Super Smash Bros Brawl Menu Theme',
  'New Super Mario Bros Wii Title Theme',
  'Mario Kart 8 Menu Theme',
  'Nintendo Wi-Fi Connection Theme',
  'Mii Maker Theme',
];

const WANT = /(wii|mii|mario kart|nintendo|3ds|animal crossing|smash bros|super mario)/i;
/* Naming the game is not enough - a rap track called "Mario Kart" is a song
   about it, not menu music. */
const IS_THEME = /theme|menu|lobby|channel|plaza|title|sports|party|\bog\b|soundtrack|\bhome\b|main/i;
const IS_SONG = /\brap\b|freestyle|diss|lyrics|official music video/i;
/* Licensed games carry the console name in their title, so "The
   Backyardigans Nintendo DS" passes every other test. These are games
   that ran on the hardware, not the hardware's own menu music. */
const OFF_BRAND = /backyardigans|spongebob|barbie|dora the explorer/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* YouTube titles are not labels. The uploader is meaningless here
   ("LuisFerLCC 2", "edv"), and titles carry channel tags, quality markers and
   a repeated game name: "Wii Shop - Wii Shop Channel - Main Theme". Turn each
   one into "Game - Track" so the panel reads like the Minecraft original. */
const GAMES = [
  [/wii\s*u|wara\s*wara/i, 'Wii U'],
  [/3ds/i, 'Nintendo 3DS'],
  [/nintendo\s*switch/i, 'Nintendo Switch'],
  [/nintendo\s*ds/i, 'Nintendo DS'],
  [/animal\s*crossing/i, 'Animal Crossing'],
  [/smash\s*bros/i, 'Smash Bros'],
  [/mario\s*kart\s*8/i, 'Mario Kart 8'],
  [/new\s*super\s*mario\s*bros/i, 'New Super Mario Bros'],
  [/wii\s*fit/i, 'Wii Fit'],
  [/wii\s*play/i, 'Wii Play'],
  [/wii\s*music/i, 'Wii Music'],
  [/photo\s*channel/i, 'Photo Channel'],
  [/mii\s*maker/i, 'Mii Maker'],
  [/wi-?fi\s*connection/i, 'Nintendo Wi-Fi'],
  [/mario\s*kart\s*wii/i, 'Mario Kart Wii'],
  [/wii\s*sports\s*resort/i, 'Wii Sports Resort'],
  [/wii\s*sports/i, 'Wii Sports'],
  [/wii\s*party/i, 'Wii Party'],
  [/wii\s*shop/i, 'Wii Shop'],
  [/mii\s*channel|mii\s*plaza/i, 'Mii Channel'],
  [/\bwii\b/i, 'Wii'],
];

function clean(title) {
  let game = 'Nintendo';
  for (const [re, name] of GAMES) { if (re.test(title)) { game = name; break; } }

  let t = title;
  t = t.split('|')[0];                                  // channel tags after a pipe
  t = t.replace(/\[[^\]]*\]/g, ' ');                    // [OST], [HQ], [Original]
  t = t.replace(/\((?:hq|hd|full|audio|official|free|no copyright)[^)]*\)/gi, ' ');
  t = t.replace(/\*[^*]*\*/g, ' ');                     // *60s Space Age Exotica*
  t = t.replace(/^\s*\d+\s*[.)-]\s*/, '');              // leading "5. "
  /* Drop the game name wherever it appears, then the words that are true of
     every entry and so carry no information. */
  t = t.replace(new RegExp(game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  t = t.replace(/\b(lobby music|music pack|soundtrack|ost|main theme music|background music|system soundtrack|nintendo|music|theme song)\b/gi, ' ');
  t = t.replace(/\b(remastered|100% accurate|full instrumental remake|version)\b/gi, ' ');
  t = t.replace(/[\s\-–—:]+/g, ' ');
  /* Stripping words inside brackets leaves debris: "( / Lobby Track)",
     "(Nostalgia )", "()". Tidy the brackets before the final trim. */
  t = t.replace(/\(\s*[/\-–—,]*\s*\)/g, ' ');           // empty or punctuation-only
  t = t.replace(/\(\s*[/\-–—,]\s*/g, '(');              // "( / Lobby" -> "(Lobby"
  t = t.replace(/\s+\)/g, ')');                          // "(Nostalgia )" -> "(Nostalgia)"
  t = t.replace(/\(\s*\)/g, ' ');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '').trim();
  /* A single dangling capital is the tail of a name we cut ("Wii Party U"). */
  t = t.replace(/\s+[A-Z]$/, '').trim();

  if (!t || t.length < 2) t = 'Theme';
  if (t.length > 46) t = t.slice(0, 45).trim() + '…';
  /* Title-case a shouted title, leave mixed case alone. */
  if (t === t.toUpperCase()) {
    t = t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return { a: game, t };
}

async function search(term) {
  try {
    const r = await fetch(API + '/api/music/search?limit=12&q=' + encodeURIComponent(term),
      { signal: AbortSignal.timeout(45000) });
    if (!r.ok) return [];
    const j = await r.json();
    return j.tracks || j.results || j.items || (Array.isArray(j) ? j : []);
  } catch { return []; }
}

const seen = {};
const out = [];

for (const q of QUERIES) {
  const res = await search(q);
  for (const t of res) {
    const id = String(t.id || '');
    if (!/^yt./.test(id)) continue;             // youtube only - it is the only provider that has these
    const vid = id.slice(2);
    const title = String(t.title || t.t || '');
    const artist = String(t.artist || t.a || '');
    if (!WANT.test(title)) continue;
    if (!IS_THEME.test(title)) continue;
    if (IS_SONG.test(title)) continue;
    if (OFF_BRAND.test(title)) continue;
    if (seen[vid]) continue;
    seen[vid] = 1;
    const label = clean(title);
    out.push({ v: vid, t: label.t, a: label.a, raw: title, up: artist });
  }
  await sleep(500);
}

out.sort((a, b) => (a.t + a.a).localeCompare(b.t + b.a));
fs.mkdirSync('public/themes', { recursive: true });
fs.writeFileSync('public/themes/list.json', JSON.stringify(out));

console.log('  ' + out.length + ' youtube themes');
out.forEach((s) => console.log('    ' + (s.a + ' - ' + s.t).padEnd(52) + '  <- ' + s.raw.slice(0, 44)));
if (!out.length) console.log('  nothing matched - is the proxy running on ' + API + '?');
