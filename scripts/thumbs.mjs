/**
 * Generates a real thumbnail for every game in public/g/.
 *
 * The UGS dump is HTML loaders and nothing else - no artwork, no metadata - so
 * the only way to get pictures is to run each game and photograph it. Loads
 * every file in headless Chrome, waits for it to actually draw something, and
 * saves a JPEG next to it.
 *
 * Resumable: anything already in public/g/thumbs/ is skipped, so it can be
 * stopped with Ctrl+C and restarted without losing work.
 */
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GDIR = join(ROOT, 'public', 'g');
const OUT = join(GDIR, 'thumbs');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080') + '/g/';

const CONCURRENCY = 4;
const FIRST_WAIT = 5500;      // most games have drawn by here
const RETRY_WAIT = 11000;     // heavy Unity/WebGL titles need longer
const MIN_BYTES = 3000;       // below this the shot is essentially blank

mkdirSync(OUT, { recursive: true });
const games = JSON.parse(readFileSync(join(GDIR, 'index.json'), 'utf8'));

const todo = games.filter((g) => {
  const out = join(OUT, g.f + '.jpg');
  if (!existsSync(out)) return true;
  try { return statSync(out).size < MIN_BYTES; } catch { return true; }
});

console.log(`${games.length} games, ${games.length - todo.length} already done, ${todo.length} to go`);
if (!todo.length) process.exit(0);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

let done = 0, blank = 0, failed = 0;
const started = Date.now();

async function shoot(page, game, wait) {
  await page.goto(BASE + encodeURIComponent(game.f), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, wait));
  const out = join(OUT, game.f + '.jpg');
  await page.screenshot({ path: out, type: 'jpeg', quality: 72 });
  return statSync(out).size;
}

async function worker(id) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 400, deviceScaleFactor: 1 });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));   // some games alert() on load
  page.on('pageerror', () => {});
  for (;;) {
    const game = todo.shift();
    if (!game) break;
    try {
      let size = await shoot(page, game, FIRST_WAIT);
      // A near-uniform frame means it had not drawn yet - give it one more go.
      if (size < MIN_BYTES) size = await shoot(page, game, RETRY_WAIT);
      if (size < MIN_BYTES) blank++;
    } catch {
      failed++;
    }
    done++;
    if (done % 25 === 0) {
      const mins = (Date.now() - started) / 60000;
      const rate = done / mins;
      const left = Math.round(todo.length / Math.max(rate, 0.1));
      console.log(`${done} done | ${blank} blank | ${failed} failed | ~${left} min left`);
    }
  }
  await page.close().catch(() => {});
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await browser.close();
console.log(`finished: ${done} shot, ${blank} came out blank, ${failed} failed`);
