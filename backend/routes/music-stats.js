/**
 * Play counts, shared across everyone who uses the site.
 *
 * "Top hits" used to be a hardcoded chart from the upstream seed data. This
 * makes it mean what it says: the songs actually played most on this site.
 *
 * Counts live in one small JSON file. Writes are debounced because a play can
 * fire every few seconds and this runs on a home machine, not a database
 * server. Recents and favourites are deliberately NOT here - those are per
 * person and stay in the browser.
 */
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const router = express.Router();
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DIR, 'plays.json');

let plays = {};
try { plays = JSON.parse(readFileSync(FILE, 'utf8')); } catch { plays = {}; }

let dirty = false;
let flushTimer = null;
function flushSoon() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(plays));
    } catch { /* a lost count is not worth crashing over */ }
  }, 5000);
}

const clean = (s, n) => String(s || '').slice(0, n).trim();

router.post('/played', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const title = clean(b.title, 120);
  if (!title) return res.status(400).json({ ok: false });
  const artist = clean(b.artist, 120);
  const key = (title + '|' + artist).toLowerCase();
  const row = plays[key] || { title, artist, artwork: clean(b.artwork, 400), count: 0 };
  row.count += 1;
  row.title = title;
  row.artist = artist;
  if (b.artwork) row.artwork = clean(b.artwork, 400);
  row.last = Date.now();
  plays[key] = row;
  flushSoon();
  res.json({ ok: true, count: row.count });
});

router.get('/top', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 24;
  if (limit > 100) limit = 100;
  const rows = Object.keys(plays)
    .map((k) => plays[k])
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => ({
      id: 'it0',
      title: r.title,
      artist: r.artist,
      artwork: r.artwork || null,
      plays: r.count,
    }));
  res.json({ tracks: rows, total: Object.keys(plays).length });
});

export default router;
