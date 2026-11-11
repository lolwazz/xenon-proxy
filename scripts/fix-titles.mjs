/**
 * Gives the games whose title is still their squashed filename
 * ("clstickfighter", "10minutestilldawn") a readable one.
 *
 *   node scripts/fix-titles.mjs            show what would change
 *   node scripts/fix-titles.mjs --write    apply to index.json + popular.json
 *
 * Ways to a title, in order:
 *  1. Exact: the same letters, ignoring spaces and punctuation, already appear
 *     as a properly written title in a trusted list - arcady-titles.json, the
 *     art lookups (art.json), or the 21k-game web catalog (web.json).
 *  2. Split: break the letters into words, using how often each word occurs in
 *     those titles (the most likely split wins) - but only when every piece is
 *     a known word.
 *  3. Kept: otherwise the name stays one word, capitalised, with only a
 *     trailing number, "Game", ".io" or "3D" split off ("Goonhub 2").
 *
 * Results are kept in public/g/titles-fixed.json, which build-games.mjs reads
 * like arcady-titles.json, so a rebuild of index.json keeps them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const G = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'g');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(G, f), 'utf8')); } catch { return d; } };
const WRITE = process.argv.includes('--write');

const index = read('index.json', []);
const popular = read('popular.json', []);
const arcady = read('arcady-titles.json', {});
const art = read('art.json', {});
const web = read('web.json', []);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => fold(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const squashed = (t) => /^[a-z0-9]{5,}$/.test(t) && !/^\d+$/.test(t);

// Properly written titles: more than one word. A one-word title in these
// lists is often itself a squashed name ("Cuttherope"), so it only counts
// through the word vocabulary below, not as an exact match.
const good = [];
const addGood = (t) => { t = String(t || '').trim(); if (t && !squashed(t)) good.push(t); };
/* Not index.json or popular.json: many of their spaced titles are earlier
   automatic splits ("Angry Bird Sshowdown") and would teach the same mistakes. */
Object.values(arcady).forEach(addGood);
Object.values(art).forEach((a) => { if (a) { addGood(a.t); addGood(a.article); } });
web.forEach((g) => addGood(g.t));

const byNorm = new Map();
for (const t of good) { if (!/[\s:]/.test(t)) continue; const k = norm(t); if (k.length >= 4 && !byNorm.has(k)) byNorm.set(k, t); }

// Word vocabulary: each word's count and its most common written form
// ("baldis" -> "Baldi's", "fnaf" -> "FNAF").
const freq = new Map(), forms = new Map();
let total = 0;
for (const t of good) {
  for (const raw of t.split(/\s+/)) {
    const disp = raw.replace(/^[^A-Za-z0-9À-ɏ]+|[^A-Za-z0-9À-ɏ']+$/g, '');
    const k = norm(disp);
    if (!k) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
    total++;
    const m = forms.get(k) || new Map();
    m.set(disp, (m.get(disp) || 0) + 1);
    forms.set(k, m);
  }
}
// A long word seen once is usually a squashed title, not a real word.
for (const [k, n] of freq) if (n === 1 && k.length >= 10) freq.delete(k);
// Plurals and -er forms of words already known: "dashers", "drivers".
for (const [k, n] of [...freq]) { if (k.length >= 4 && /^[a-z]+$/.test(k)) for (const suf of ['s', 'es', 'er', 'ers']) { if (!freq.has(k + suf)) freq.set(k + suf, Math.max(1, n >> 4)); } }
for (const w of ['io', 'vs', 'the', 'of', 'and', 'a', 'in', 'on', 'at', 'to', 'my', 'me', 'up', 'no', 'go']) freq.set(w, (freq.get(w) || 0) + 50);
const OK2 = /^(iv|vi|io|vs|of|in|on|at|to|my|me|up|no|go|ii|3d|2d|ai|ds|dx|ok|oh|hi|ox|ex|tv|pc|uk|us|ny|nz|vr|ar|we|be|do|it|is|or|an|by|so|mr)$/;
function wcost(w) {
  if (/^\d+$/.test(w)) return 2;
  if (/^\d+d$/.test(w)) return 3;
  const f = freq.get(w);
  if (!f) return null;
  let c = Math.log(total / f);
  if (w.length === 1) c += w === 'a' ? 3 : 14;
  else if (w.length === 2) c += OK2.test(w) ? 2 : 8;
  else if (w.length === 3) c += 3;
  return c;
}
/* Most likely split by word frequency (lowest total cost). An unknown run
   costs more than any reasonable split, so it is only used when needed. */
function split(s) {
  const n = s.length;
  const best = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 24); j < i; j++) {
      const w = s.slice(j, i);
      let c = wcost(w);
      if (c === null) c = 10 + 4 * w.length;
      if (best[j] + c < best[i]) { best[i] = best[j] + c; from[i] = j; }
    }
  }
  const out = [];
  for (let i = n; i > 0; i = from[i]) out.unshift(s.slice(from[i], i));
  const merged = [];
  for (const w of out) {
    const unk = wcost(w) === null;
    const last = merged[merged.length - 1];
    if (unk && last && last.unk) last.w += w;
    // "60" + "s" -> "60s"
    else if (w === 's' && last && /^\d+$/.test(last.w)) last.w += w;
    else merged.push({ w, unk });
  }
  return { words: merged, cost: best[n] };
}
/* A split is trusted when every piece is a real word or number, no piece is a
   stray letter, two-letter pieces are common ones, and anything unknown is at
   least four letters (a name the vocabulary has not seen). */
function trusted(words) {
  return words.every((x, i) => {
    if (x.unk) return x.w.length >= 4;
    if (/^\d+d?s?$/.test(x.w)) return true;
    if (x.w.length === 1) return x.w === 'a' && i < words.length - 1;
    if (x.w.length === 2) return OK2.test(x.w);
    return true;
  });
}
const UPPER = /^(io|ii|iii|iv|vi|vii|viii|ix|xi|xii|vs|3d|2d|fps|nfs|gta|fnaf|cps|lol|ny|ufo|rpg|tnt|usa|ai|dx|ds|gba|nes|snes|tv|pc|vr|csgo|ksi|fbi)$/;
const SMALL = /^(of|the|and|a|an|in|on|at|to|vs|or|for|is|by)$/;
function show(x, i) {
  const w = x.w;
  if (w === 'io') return i > 0 ? '.io' : 'IO';
  if (UPPER.test(w)) return w.toUpperCase();
  if (/^[0-9]/.test(w)) return w.replace(/d$/, 'D');
  const m = forms.get(w);
  let d = w;
  let bestN = 0;
  if (m) { for (const [form, n] of m) if (n > bestN) { bestN = n; d = form; } }
  // One title shouting a word ("Look OUTSIDE") or styling it ("DiamonD") is
  // not how to write it everywhere else.
  if (d.length > 3 && d === d.toUpperCase()) d = d.charAt(0) + d.slice(1).toLowerCase();
  if (/[a-z][A-Z]/.test(d) && bestN < 3) d = w;
  if (i > 0 && SMALL.test(w)) return w;
  return d.charAt(0).toUpperCase() + d.slice(1);
}
const SUF = ['game', 'online', 'unblocked', 'remastered', 'deluxe', 'classic', 'plus', 'io', '3d', '2d'];
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
/* Well-known games the vocabulary cannot split on its own (one of their words
   appears nowhere else). Keyed by the squashed name without a trailing number
   or "game", so "crashbandicoot2" becomes "Crash Bandicoot 2". */
const MANUAL = {
  buckshotoulette: 'Buckshot Roulette', '3dasheditor': '3Dash Editor', '99nightsitf': '99 Nights in the Forest',
  cheeseisthereason: 'Cheese Is the Reason', fivenightsatshreks: "Five Nights at Shrek's", fivenightsatyoshis: "Five Nights at Yoshi's",
  gdsubzero: 'Geometry Dash SubZero', momimsleeping: "Mom I'm Sleeping", polytrackbutnotflagged: 'PolyTrack But Not Flagged',
  achievementunlocked: 'Achievement Unlocked', adventurecapitalist: 'AdVenture Capitalist', alienhominid: 'Alien Hominid',
  apesvshelium: 'Apes vs Helium', baconmaydie: 'Bacon May Die', banjokazooie: 'Banjo-Kazooie', basketballfrvr: 'Basketball FRVR',
  bigneontowertinysqaure: 'Big NEON Tower Tiny Square', bindingofisaac: 'Binding of Isaac', thebindingofisaac: 'The Binding of Isaac',
  thebindingofisaacrebirth: 'The Binding of Isaac: Rebirth', thebindingofisaacwrathofthelambeternal: 'The Binding of Isaac: Wrath of the Lamb Eternal',
  blumgiracers: 'Blumgi Racers', blumgirocket: 'Blumgi Rocket', blumgislime: 'Blumgi Slime', boomslingersreboom: 'Boom Slingers: Reboom',
  buildnowgg: 'BuildNow GG', burritobison: 'Burrito Bison', camouflageandsniper: 'Camouflage and Sniper',
  castlevaniatheadventure: 'Castlevania: The Adventure', celestepico: 'Celeste Pico', choppyorc: 'Choppy Orc', clusterrush: 'Cluster Rush',
  counterstrikeds: 'Counter-Strike DS', crashbandicoot: 'Crash Bandicoot', csgoclicker: 'CS:GO Clicker', dailydadish: 'Daily Dadish',
  dantheman: 'Dan the Man', dontyoulectureme: "Don't You Lecture Me", dreadheadparkour: 'Dreadhead Parkour', drivenwild: 'Driven Wild',
  emulatorjs: 'EmulatorJS', escapingtheprison: 'Escaping the Prison', fearstofathom: 'Fears to Fathom', finalfantasyvii: 'Final Fantasy VII',
  fleeingthecomplex: 'Fleeing the Complex', fnafucn: 'FNaF UCN', fnfvshatsunemiku: 'FNF vs Hatsune Miku', forknsausage: 'Fork N Sausage',
  gimmetheairpod: 'Gimme the Airpod', godzilladaikaijubattleroyale: 'Godzilla Daikaiju Battle Royale', googlebaseball: 'Google Baseball',
  googledino: 'Google Dino', googlefeud: 'Google Feud', grandtheftautoiii: 'Grand Theft Auto III', grandtheftautoiv: 'Grand Theft Auto IV',
  grandtheftautosanandreas: 'Grand Theft Auto: San Andreas', gtachinatownwars: 'GTA Chinatown Wars', guesstheiranswer: 'Guess Their Answer',
  halflifeopposingforce: 'Half-Life: Opposing Force', happysheepies: 'Happy Sheepies', humanexpenditureprogram: 'Human Expenditure Program',
  ihavenomouthandimustscream: 'I Have No Mouth, and I Must Scream', infiltratingtheairship: 'Infiltrating the Airship', ironlung: 'Iron Lung',
  iwokeupnexttoyouagain: 'I Woke Up Next to You Again', kitchenbazar: 'Kitchen Bazar', layersroll: 'Layers Roll',
  legobatman2dcsuperheroes: 'LEGO Batman 2: DC Super Heroes', legobatmanthevideogame: 'LEGO Batman: The Video Game', maxpayne: 'Max Payne',
  metalgearsolid: 'Metal Gear Solid', metroidzeromission: 'Metroid: Zero Mission', ninjavsevilcorp: 'Ninja vs EVILCORP',
  nubbysnumberfactory: "Nubby's Number Factory", omnomrun: 'Om Nom Run', oshioshipunch: 'Oshi Oshi Punch', paperyplanes: 'Papery Planes',
  parappatherapper: 'PaRappa the Rapper', peaksofyore: 'Peaks of Yore', pleasedonttouchanything: "Please Don't Touch Anything",
  pokemongaia: 'Pokémon Gaia', pokemonplatinum: 'Pokémon Platinum', pokemonquetzal: 'Pokémon Quetzal', pokemonsapphire: 'Pokémon Sapphire',
  pokemonstadium: 'Pokémon Stadium', pokemonunbound: 'Pokémon Unbound', pokemonswordandshieldultimateplus: 'Pokémon Sword and Shield Ultimate Plus',
  pretenditsnotthere: "Pretend It's Not There", quake3arena: 'Quake III Arena', revelationspersona: 'Revelations: Persona',
  riddletransfer: 'Riddle Transfer', royaltowermedievaltd: 'Royal Tower Medieval TD', serialexperimentslain: 'Serial Experiments Lain',
  sideeffects: 'Side Effects', sonicadvance: 'Sonic Advance', soniccd: 'Sonic CD', sonicclassiccollection: 'Sonic Classic Collection',
  sonicmania: 'Sonic Mania', sonicthehedgehog2communityscut: "Sonic the Hedgehog 2 Community's Cut", spacefuneral: 'Space Funeral',
  spelunkyclassichd: 'Spelunky Classic HD', spongebobsquarepantskrabbykatch: 'SpongeBob SquarePants: Krabby Katch', stardewvalley: 'Stardew Valley',
  stealingthediamond: 'Stealing the Diamond', supermariogalaxyds: 'Super Mario Galaxy DS', supermonkeyballjr: 'Super Monkey Ball Jr.',
  survivetovictory: 'Survive to Victory', taikonotatsujin: 'Taiko no Tatsujin', tanukisunset: 'Tanuki Sunset', telekinesisattack: 'Telekinesis Attack',
  telekinesiscar: 'Telekinesis Car', telekinesisdrive: 'Telekinesis Drive', thatsnotmyneighbour: "That's Not My Neighbour",
  thelegendofzeldatheminishcap: 'The Legend of Zelda: The Minish Cap', theoregontrail: 'The Oregon Trail', theyarecoming: 'They Are Coming',
  threegoblets: 'Three Goblets', tomclancysrainbowsix: "Tom Clancy's Rainbow Six", tomodachicollection: 'Tomodachi Collection',
  triviacrack: 'Trivia Crack', umjammerlammy: 'Um Jammer Lammy', vaportrails: 'Vapor Trails', warregions: 'War Regions', yohoho: 'YoHoHo',
  kajirun: 'Kaji Run', littlerunmo: 'Little Runmo', kirbysadventure: "Kirby's Adventure", '2doom': '2DOOM', ruffleemu: 'Ruffle Emu',
  heliosbrowser: 'Helios Browser', undertaleyellow: 'Undertale Yellow', cuttherope: 'Cut the Rope', fancypantsadventure: 'Fancy Pants Adventure',
  attackhole: 'Attack Hole', asmallworldcup: 'A Small World Cup', learntoflyidle: 'Learn to Fly Idle', finalearth: 'Final Earth',
  badparenting: 'Bad Parenting', baldursgate: "Baldur's Gate", bendyandtheinkmachine: 'Bendy and the Ink Machine', crazycattle: 'Crazy Cattle',
  evolvingbombs: 'Evolving Bombs', madalinstuntcars: 'Madalin Stunt Cars', minecraftbeta: 'Minecraft Beta', mutilateadoll: 'Mutilate-a-Doll',
  myteardrop: 'My Teardrop', nickelodeonsuperbrawl: 'Nickelodeon Super Brawl', theelderscrolls: 'The Elder Scrolls',
  thingthingarena: 'Thing Thing Arena', tonyhawksproskater: "Tony Hawk's Pro Skater", twerkrace: 'Twerk Race',
  sonicthehedgehog3angelisland: 'Sonic the Hedgehog 3: Angel Island',
};
/* Split when every piece is a known word; otherwise keep the name as one
   word and only peel off what is certain (a number, "game", ".io", "3D"). */
function titleFor(core) {
  if (MANUAL[core]) return { t: MANUAL[core], how: 'manual' };
  let head = core;
  const tail = [];
  for (let guard = 0; guard < 4; guard++) {
    const d = head.match(/^(.{3,}?)(\d+)$/);
    if (d) { tail.unshift(d[2]); head = d[1]; continue; }
    const w = SUF.find((x) => head.length > x.length + 2 && head.endsWith(x));
    if (w) { tail.unshift(w); head = head.slice(0, -w.length); continue; }
    break;
  }
  let h, how = 'kept';
  const r = split(core);
  if (MANUAL[head]) { h = MANUAL[head]; how = 'manual'; }
  else if (trusted(r.words) && !r.words.some((x) => x.unk)) return { t: r.words.map(show).join(' ').replace(/ \.io$/, '.io'), how: 'split' };
  const hs = split(head);
  if (h) { /* manual */ }
  else if (tail.length && trusted(hs.words) && !hs.words.some((x) => x.unk)) h = hs.words.map(show).join(' ');
  else if (/^papas.{4,}/.test(head)) h = "Papa's " + cap(head.slice(5));
  else h = cap(head);
  let t = h;
  for (const w of tail) t += w === 'io' ? '.io' : ' ' + (/^\d+d$/.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : cap(w));
  return { t, how };
}

const fixed = read('titles-fixed.json', {});
const changes = [];
for (const g of index) {
  if (!squashed(g.t)) continue;
  let core = g.t;
  // arclstickfighter.html came in titled "clstickfighter": a second
  // collection prefix. Only that exact pattern is stripped, so real names
  // that start with the letters (Cluster Rush, Archery World Tour) keep them.
  const stem = g.f.replace(/\.html?$/i, '').split('/').pop();
  if (stem === 'ar' + core && /^cl./.test(core)) core = core.slice(2);
  let t = byNorm.get(core), how = 'exact';
  // A source that wrote it all lowercase still gets capitals.
  if (t && t === t.toLowerCase()) t = t.replace(/(^|\s)([a-z])/g, (m, x, y) => x + y.toUpperCase());
  if (!t) ({ t, how } = titleFor(core));
  if (t && t !== g.t) changes.push({ f: g.f, from: g.t, to: t, how });
}

for (const c of changes) console.log((c.how.padEnd(12)) + c.from.padEnd(40) + ' -> ' + c.to);
const counts = changes.reduce((a, c) => { a[c.how] = (a[c.how] || 0) + 1; return a; }, {});
console.log('\n' + changes.length + ' titles', JSON.stringify(counts));

if (WRITE) {
  for (const c of changes) fixed[c.f] = c.to;
  const titleOf = (f, t) => fixed[f] || t;
  const ni = index.map((g) => ({ ...g, t: titleOf(g.f, g.t) }));
  const np = popular.map((g) => ({ ...g, t: titleOf(g.f, g.t) }));
  const put = (f, v) => { fs.writeFileSync(path.join(G, f + '.tmp'), JSON.stringify(v)); fs.renameSync(path.join(G, f + '.tmp'), path.join(G, f)); };
  put('titles-fixed.json', fixed);
  put('index.json', ni);
  put('popular.json', np);
  console.log('written: index.json, popular.json, titles-fixed.json');
}
