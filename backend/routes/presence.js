/**
 * Who is on the site right now.
 *
 * Deliberately NOT stored in WordPress: a ping every 30 seconds per visitor
 * would be exactly the write storm that knocked the shared host over earlier.
 * This is in memory - presence is worthless once it is stale, so losing it on
 * restart costs nothing.
 */
import express from 'express';

const router = express.Router();
const people = new Map();                 // id -> { name, pfp, last, first }
const ONLINE_MS = 90 * 1000;              // seen within 90s counts as online
const KEEP_MS = 24 * 60 * 60 * 1000;      // remember "last online" for a day

const clean = (s, n) => String(s == null ? '' : s).slice(0, n).trim();

function sweep() {
  const now = Date.now();
  for (const [id, p] of people) {
    if (now - p.last > KEEP_MS) people.delete(id);
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();

router.post('/ping', express.json({ limit: '256kb' }), (req, res) => {
  const b = req.body || {};
  const id = clean(b.id, 64);
  if (!id) return res.status(400).json({ ok: false });
  const now = Date.now();
  const prev = people.get(id);
  people.set(id, {
    name: clean(b.name, 24) || 'anon',
    // Avatars are small data URLs from the profile editor; cap hard so one
    // person cannot push megabytes into memory.
    pfp: typeof b.pfp === 'string' && b.pfp.length < 200000 ? b.pfp : (prev ? prev.pfp : ''),
    bio: clean(b.bio, 140),
    last: now,
    first: prev ? prev.first : now,
  });
  const online = [...people.values()].filter((p) => now - p.last < ONLINE_MS).length;
  res.json({ ok: true, online });
});

router.get('/', (req, res) => {
  const now = Date.now();
  const list = [...people.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, 60)
    .map((p) => ({
      name: p.name,
      bio: p.bio,
      pfp: p.pfp || null,
      online: now - p.last < ONLINE_MS,
      ago: Math.round((now - p.last) / 1000),
    }));
  res.json({ online: list.filter((p) => p.online).length, people: list });
});

export default router;
