/**
 * Builds popular.json: every game that has cover art.
 *
 * It used to be a hand-written list of well-known titles, which meant most of
 * the page was blank coloured squares. Having art is a better signal anyway -
 * a game only has a cover because someone bothered to make one for it, so the
 * set of games with art is roughly the set of games people actually play.
 *
 * Two sources count as art:
 *   covers.json - images copied onto this server (see arcady-covers.mjs)
 *   art.json    - remote images found on Wikipedia (see game-art.mjs)
 *
 * Usage: node scripts/build-popular.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'g');

const read = (f, fb) => (existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), 'utf8')) : fb);

const all = read('index.json', []);
const covers = read('covers.json', {});
const art = read('art.json', {});

const hasArt = (f) => Boolean(covers[f] || (art[f] && art[f].img));

const picked = all
  .filter((g) => hasArt(g.f))
  .sort((a, b) => a.t.localeCompare(b.t, 'en', { numeric: true }));

writeFileSync(join(DIR, 'popular.json'), JSON.stringify(picked));

console.log('  ' + picked.length + ' games with art -> popular.json');
console.log('    local covers: ' + picked.filter((g) => covers[g.f]).length);
console.log('    remote art:   ' + picked.filter((g) => art[g.f] && art[g.f].img).length);
console.log('');
picked.slice(0, 8).forEach((g) => console.log('    ' + g.t));
