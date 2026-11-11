/* Points game files at GitHub raw (through /cdn) wherever they load from a
 * GitHub user jsDelivr now refuses. See backend/cdn-unblock.js.
 *
 * Every changed file is backed up first, outside public/ so the backups are
 * never served: backups/unblock-<date>/<path inside public/g>.
 *
 * Usage: node scripts/unblock-jsdelivr.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unblockText } from '../backend/cdn-unblock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'g');
const BACKUP = path.join(ROOT, 'backups', 'unblock-' + new Date().toISOString().slice(0, 10));
const DRY = process.argv.includes('--dry');
const TEXT = /\.(html?|js|mjs|json|css)$/i;
const MAX = 30 * 1024 * 1024;

let changed = 0, scanned = 0;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!TEXT.test(e.name)) continue;
    const st = fs.statSync(p);
    if (st.size > MAX) continue;
    scanned++;
    const s = fs.readFileSync(p, 'latin1');
    const out = unblockText(s);
    if (out === s) continue;
    changed++;
    files.push(path.relative(SRC, p));
    if (DRY) continue;
    const b = path.join(BACKUP, path.relative(SRC, p));
    fs.mkdirSync(path.dirname(b), { recursive: true });
    if (!fs.existsSync(b)) fs.copyFileSync(p, b);
    fs.writeFileSync(p, out, 'latin1');
  }
})(SRC);
console.log(`scanned ${scanned} text files, ${DRY ? 'would change' : 'changed'} ${changed}` + (DRY ? '' : `, backups in ${path.relative(ROOT, BACKUP)}`));
console.log(files.slice(0, 15).join('\n'));
