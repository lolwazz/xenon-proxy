/* Indexes public/themes/ into public/themes/list.json for the Now Playing
 * toast. Drop audio files in there named "Artist - Title.mp3" and re-run:
 *   node scripts/build-themes.mjs
 * A subfolder becomes the label shown on the toast if there is no " - ".
 */
import fs from 'node:fs';
import path from 'node:path';

const root = 'public/themes';
const AUDIO = /\.(mp3|ogg|m4a|wav|webm|opus)$/i;
const out = [];

function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { walk(abs, r); continue; }
    if (!AUDIO.test(e.name)) continue;
    const base = e.name.replace(AUDIO, '');
    const dash = base.split(' - ');
    out.push({
      f: r,
      a: dash.length > 1 ? dash[0].trim() : (rel || 'Xenon'),
      t: dash.length > 1 ? dash.slice(1).join(' - ').trim() : base,
      kb: Math.round(fs.statSync(abs).size / 1024),
    });
  }
}

walk(root, '');
out.sort((x, y) => (x.a + x.t).localeCompare(y.a + y.t));
fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(out));

console.log('  indexed ' + out.length + ' theme' + (out.length === 1 ? '' : 's'));
out.forEach((s) => console.log('    ' + s.a + ' - ' + s.t + '  (' + s.kb + 'k)'));
if (!out.length) {
  console.log('');
  console.log('  Nothing there yet. Put audio files in public/themes/ and re-run.');
  console.log('  Name them "Artist - Title.mp3" and the toast reads both parts.');
}
