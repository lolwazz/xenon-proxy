/**
 * Turns the UGS dump in public/g/ into public/g/index.json.
 *
 * The filenames are the only metadata there is: mostly "cl" + a squashed
 * lowercase title, e.g. cl1v1lol.html, cl2048.html, clgeometrydash.html.
 * Splitting those back into words is guesswork, so this uses a dictionary of
 * the words that actually occur in this collection and falls back to leaving a
 * run of letters alone rather than inventing breaks.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'g');

// Words worth splitting on, longest first so "minecraft" wins over "mine".
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

// Only split on words of 4+ characters. Short ones ("me", "us", "io", "run")
// match inside longer words and shred titles into nonsense.
const SAFE = WORDS.filter((w) => w.length >= 4);

function split(raw) {
  let s = raw, out = [], guard = 0;
  while (s.length && guard++ < 60) {
    const w = SAFE.find((x) => s.startsWith(x));
    if (w) { out.push(w); s = s.slice(w.length); continue; }
    // Unknown run: keep it whole rather than inventing word breaks.
    let i = 1;
    while (i < s.length && !SAFE.some((x) => s.startsWith(x, i))) i++;
    out.push(s.slice(0, i));
    s = s.slice(i);
  }
  return out;
}

const titleCase = (w) =>
  /^(io|ii|iii|iv|vs|3d|2d|fps|nfs|gta|fnaf|cps|lol|ny)$/i.test(w)
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1);

function toTitle(file) {
  let n = file.replace(/\.html$/i, '').replace(/\s*\(\d+\)$/, '');
  n = n.replace(/^cl(?=[A-Za-z0-9])/, '');
  if (/[A-Z_\- ]/.test(n.slice(1))) {            // already human-readable
    const h = n.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return h.charAt(0).toUpperCase() + h.slice(1);
  }

  // "1v1lol" and friends: keep the NvN token together.
  const nvn = n.match(/^(\d+v\d+)/);
  let lead = '';
  if (nvn) { lead = nvn[1]; n = n.slice(lead.length); }
  else {
    const d = n.match(/^\d+/);
    if (d) { lead = d[0]; n = n.slice(lead.length); }
  }

  let parts = split(n).filter(Boolean).map(titleCase);
  // A dictionary word eats the stem and leaves its plural stranded as a lone
  // "S" ("Basketball Legend S"). Glue any 1-char tail back onto the word.
  parts = parts.reduce((acc, w) => {
    if (acc.length && w.length === 1 && /[a-z]/i.test(w)) {
      acc[acc.length - 1] += w.toLowerCase();
      return acc;
    }
    acc.push(w);
    return acc;
  }, []);
  const out = [lead, ...parts].filter(Boolean).join(' ').trim();
  return out.replace(/\s+/g, ' ') || file;
}

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.html'));
const games = files
  .map((file) => ({ f: file, t: toTitle(file) }))
  .sort((a, b) => a.t.localeCompare(b.t, 'en', { numeric: true }));

writeFileSync(join(DIR, 'index.json'), JSON.stringify(games));
console.log(`${games.length} games indexed`);
console.log(games.slice(0, 12).map((g) => `  ${g.f}  ->  ${g.t}`).join('\n'));
