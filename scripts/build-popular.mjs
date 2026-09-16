/**
 * Picks the well-known titles out of the full UGS index into popular.json.
 * Matching is on the filename, which is lowercase and squashed, so the needles
 * are written the same way. First match per needle wins, so "slope" gets the
 * base game rather than "Slope 2player".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'g');
const all = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));

const NEEDLES = `slope retrobowl geometrydash subwaysurfers amongus happywheels
motox3m tunnelrush driftboss drifthunters cookieclicker 1v1lol 2048
basketballstars basketballlegends soccerlegends shellshock krunker bloxd
paperio stackball templerun ducklife fireboy vex madalin papaspizzeria
snowrider monkeymart crossyroad flappybird doodlejump gettingoverit
fridaynightfunkin tetris pacman chess checkers solitaire minecraft eaglercraft
tinyfishing rooftopsnipers awesometanks cluster rocketleague drivemad
smashkarts moto bitlife idleb cutthedry rideordie stickman helixjump
worldshardestgame runrun burritobison learntofly ballgame footballlegends
tanktrouble bubbleshooter mahjong sudoku wordle uno bloons ovo
`.trim().split(/\s+/).filter(Boolean);

const seen = new Set();
const picked = [];
for (const needle of NEEDLES) {
  const hit = all.find((g) => !seen.has(g.f) && g.f.toLowerCase().includes(needle));
  if (hit) { seen.add(hit.f); picked.push(hit); }
}
picked.sort((a, b) => a.t.localeCompare(b.t, 'en', { numeric: true }));

writeFileSync(join(DIR, 'popular.json'), JSON.stringify(picked));
console.log(`${picked.length} of ${NEEDLES.length} needles matched`);
console.log(picked.map((g) => '  ' + g.t).join('\n'));
