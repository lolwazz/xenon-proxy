/* Makes a one-time link that gives a lost chat identity back to whichever
 * browser opens it. Good for one use, 24 hours.
 *
 *   node scripts/reclaim-link.mjs > ../RECLAIM-LINK.txt
 *       the Owner: takes over the owner's name, messages, DMs and groups
 *   node scripts/reclaim-link.mjs "Typicallyome"
 *       one person, by exact chat name: their name, messages, DMs, groups
 *       and rank - never anyone else's
 *
 * Links pile up in backend/data/reclaim.json, so making one does not cancel
 * another that has not been used yet.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'data');
const FILE = join(DATA, 'reclaim.json');
const who = process.argv[2];

let pid = '';
let label = 'the Owner';
if (who) {
  const j = JSON.parse(readFileSync(join(DATA, 'chat-rooms.json'), 'utf8'));
  const hits = (j.people || []).filter((p) => p.name === who);
  if (hits.length !== 1) {
    const near = (j.people || []).filter((p) => String(p.name || '').toLowerCase().includes(who.toLowerCase())).map((p) => p.name);
    console.error(hits.length ? 'More than one person is called "' + who + '".' : 'Nobody is called exactly "' + who + '".');
    if (near.length) console.error('Close: ' + near.join(', '));
    process.exit(1);
  }
  pid = hits[0].pid;
  label = who + ((j.roles || {})[pid] ? ' (' + j.roles[pid] + ')' : '');
}

let codes = [];
try { const j = JSON.parse(readFileSync(FILE, 'utf8')); codes = Array.isArray(j) ? j : [j]; } catch {}
codes = codes.filter((c) => c && c.code && c.until > Date.now());
const code = randomBytes(48).toString('hex');
codes.push(pid ? { code, until: Date.now() + 864e5, pid } : { code, until: Date.now() + 864e5 });
writeFileSync(FILE, JSON.stringify(codes));

console.log('Reclaim link for ' + label + ' - open ONE of these, once, within 24 hours:');
console.log('https://zpack.beauty/chat/#claim=' + code);
console.log('https://xenonsschoollearning.online/chat/#claim=' + code);
