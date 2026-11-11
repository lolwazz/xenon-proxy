/* Downscales oversized .cur files to 32x32 PNGs.
 *
 * Chrome silently ignores any CSS cursor larger than 32x32 - it falls back to
 * the default arrow, so an oversized pack looks like the feature is broken.
 * Most of the Scribble and Blue sets are 64-100px. Chrome can decode .cur in
 * an <img>, so a canvas round trip gets us usable PNGs (which CSS accepts too).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();

let done = 0, skipped = 0, failed = 0;

for (const set of fs.readdirSync('public/cursors')) {
  const dir = path.join('public/cursors', set);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.cur')) continue;
    const abs = path.join(dir, file);
    const buf = fs.readFileSync(abs);
    /* A .cur is an icon directory: it can hold several sizes and Chrome
       picks a large one. Checking only entry 0 wrongly passed files whose
       later entries are 64 or 96px, which is why some cursors rendered big. */
    const count = buf.readUInt16LE(4);
    let maxDim = 0;
    for (let k = 0; k < count; k++) {
      const off = 6 + k * 16;
      maxDim = Math.max(maxDim, buf[off] || 256, buf[off + 1] || 256);
    }
    if (maxDim <= 32) { skipped++; continue; }

    const b64 = buf.toString('base64');
    const png = await page.evaluate(async (b64) => {
      const img = new Image();
      const ok = await new Promise((res) => {
        img.onload = () => res(true);
        img.onerror = () => res(false);
        img.src = 'data:image/x-icon;base64,' + b64;
      });
      if (!ok || !img.naturalWidth) return null;
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, 32, 32);
      return c.toDataURL('image/png').split(',')[1];
    }, b64);

    if (!png) { failed++; console.log('  could not decode ' + set + '/' + file); continue; }
    const out = abs.replace(/\.cur$/i, '.png');
    fs.writeFileSync(out, Buffer.from(png, 'base64'));
    done++;
  }
}

await browser.close();
console.log('  converted ' + done + ' oversized cursors to 32px png');
console.log('  already fine: ' + skipped + '   failed: ' + failed);
