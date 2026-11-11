/* Indexes the Brazilian funk pack into public/studio/samples.json.
 *
 * The pack is 242MB across 143 files, far too much to ship to a browser up
 * front, so the index carries only paths and sizes and the audio is fetched
 * per sample when it is first used.
 *
 * Usage: node scripts/build-samples.mjs "<path to pack>"
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('pack folder not found: ' + root);
  process.exit(1);
}

const AUDIO = /\.(wav|mp3|flac|ogg|m4a)$/i;
const out = [];

function walk(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const r = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) { walk(abs, r); continue; }
    if (!AUDIO.test(entry.name)) continue;
    const st = fs.statSync(abs);
    out.push({
      p: r.split(path.sep).join('/'),
      // Strip the vendor prefix and extension - "NKM_RJ - BEAT SF HIT.wav"
      // is unreadable in a narrow browser column.
      n: entry.name.replace(/^NKM_RJ\s*-\s*/i, '').replace(AUDIO, ''),
      g: (rel || 'root').split('/')[0].replace(/^\d+\.\s*/, ''),
      kb: Math.round(st.size / 1024),
    });
  }
}

walk(root, '');
out.sort((a, b) => (a.g + a.n).localeCompare(b.g + b.n));

fs.mkdirSync('public/studio', { recursive: true });
fs.writeFileSync('public/studio/samples.json', JSON.stringify(out));

const groups = {};
out.forEach((s) => { groups[s.g] = (groups[s.g] || 0) + 1; });
console.log('  indexed ' + out.length + ' samples');
Object.entries(groups).sort().forEach(([g, n]) => console.log('    ' + String(n).padStart(4) + '  ' + g));
console.log('  index size: ' + Math.round(fs.statSync('public/studio/samples.json').size / 1024) + ' KB');
