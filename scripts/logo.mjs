/* Crops the source logo to its content and exports favicon sizes.
   Re-run after changing C:/Users/mooma/Downloads/xenonlogo.png:
     node scripts/logo.mjs */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const src = 'C:/Users/mooma/Downloads/xenonlogo.png';
const outDir = 'public/brand';
fs.mkdirSync(outDir, { recursive: true });
const b64 = fs.readFileSync(src).toString('base64');

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();

const files = await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });

  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;

  // Bounding box of anything visible, so the export is not mostly padding.
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let py = 0; py < c.height; py++) {
    for (let px = 0; px < c.width; px++) {
      if (d[(py * c.width + px) * 4 + 3] > 8) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
  }
  // Keep it square and centred so it never looks lopsided in a tab.
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const side = Math.max(maxX - minX, maxY - minY) * 1.06;
  const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2), s = Math.round(side);

  const out = {};
  for (const size of [512, 192, 180, 64, 32]) {
    const o = document.createElement('canvas');
    o.width = o.height = size;
    const ox = o.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(img, sx, sy, s, s, 0, 0, size, size);
    out['xenon-' + size + '.png'] = o.toDataURL('image/png').split(',')[1];
  }
  out.__crop = { from: [c.width, c.height], box: [minX, minY, maxX, maxY], square: [sx, sy, s] };
  return out;
}, b64);

const crop = files.__crop; delete files.__crop;
console.log('  original ' + crop.from.join('x') + '  content box ' + crop.box.join(',') +
            '  -> square ' + crop.square.join(','));
for (const [name, data] of Object.entries(files)) {
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(outDir + '/' + name, buf);
  console.log('  ' + name.padEnd(16) + Math.round(buf.length / 1024) + ' KB');
}
await browser.close();
