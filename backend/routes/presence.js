/**
 * Who is on the site right now, and everyone's public profile.
 *
 * Deliberately NOT stored in WordPress: a ping every 30 seconds per visitor
 * would be exactly the write storm that knocked the shared host over earlier.
 * Presence lives in memory; profiles are flushed to data/profiles.json now and
 * then so a restart does not wipe everyone's name, avatar and border.
 *
 * The device id a browser pings with is its only credential, so it never
 * leaves this file: everything public is keyed by `uid`, a hash of it.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipsBy } from './clips.js';
import { settings, clientIp, ipHash } from '../site-settings.js';
import { hasSlur } from '../slurs.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const AVATARS = join(DATA, 'avatars');
const STORE = join(DATA, 'profiles.json');
mkdirSync(AVATARS, { recursive: true });

const router = express.Router();
const people = new Map();                 // device id -> profile
const ONLINE_MS = 90 * 1000;              // seen within 90s counts as online
const LIST_MS = 24 * 60 * 60 * 1000;      // the "who is here" list shows the last day
const AVATAR_MAX = 2.5 * 1024 * 1024;     // animated GIFs are allowed, within reason

export const BORDERS = ['none', 'neon', 'fire', 'gold', 'rainbow', 'ice', 'galaxy', 'toxic', 'sakura', 'pixel'];

/* The GIF frames (public/frames, listed in frames.json) are borders too,
   stored as "gif:<file>". Only files that are really in the list count. */
let FRAME_FILES = new Set();
try {
  const list = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'frames', 'frames.json'), 'utf8'));
  FRAME_FILES = new Set(list.map((x) => x.f));
} catch {}
export function isBorder(v) {
  if (typeof v !== 'string') return false;
  if (BORDERS.includes(v)) return true;
  return v.startsWith('gif:') && FRAME_FILES.has(v.slice(4));
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n).trim();
export const uidOf = (id) => createHash('sha256').update('xn-uid:' + id).digest('hex').slice(0, 16);

try {
  if (existsSync(STORE)) {
    /* slur-named profiles from raids are dropped on load (2026-11-15) */
    for (const [id, p] of Object.entries(JSON.parse(readFileSync(STORE, 'utf8')))) if (!hasSlur(String(p.name || ''))) people.set(id, p);
  }
} catch (err) {
  console.warn('profiles.json unreadable, starting empty: ' + err.message);
}
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    writeFileSync(STORE + '.tmp', JSON.stringify(Object.fromEntries(people)));
    renameSync(STORE + '.tmp', STORE);
  } catch (err) { console.warn('could not save profiles: ' + err.message); }
}, 30 * 1000).unref();

/* An avatar arrives as a data URL. It is written once under its own hash, so
   re-sending the same picture costs nothing, and the profile keeps the path. */
const KINDS = [
  { ext: 'gif', test: (b) => b.slice(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'png', test: (b) => b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG' },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: 'webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];
function saveAvatar(dataUrl) {
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > AVATAR_MAX) return null;
  const kind = KINDS.find((k) => k.test(buf));
  if (!kind) return null;
  const name = createHash('sha1').update(buf).digest('hex') + '.' + kind.ext;
  const file = join(AVATARS, name);
  if (!existsSync(file)) writeFileSync(file, buf);
  return '/avatars/' + name;
}

/* Set by watch.js: true while that person's game can be watched. */
let liveCheck = () => false;
export function setLiveCheck(fn) { liveCheck = fn; }

function card(p, now) {
  return {
    live: now - p.last < ONLINE_MS && liveCheck(p.uid),
    uid: p.uid,
    name: p.name,
    bio: p.bio,
    pfp: p.pfp || null,
    border: p.border || 'none',
    online: now - p.last < ONLINE_MS,
    ago: Math.round((now - p.last) / 1000),
    /* Activity status (playing, listening...) - only while they are here. */
    act: now - p.last < ONLINE_MS ? (p.act || null) : null,
  };
}

/* Raid guard (2026-11-15): blocked from the chat, the second raid spammed
   the online list with hundreds of slur-named profiles. Now: no slur names,
   no banned addresses, at most 6 new profiles per address per 10 minutes,
   and if more than 40 new profiles appear in a minute, no new profiles are
   taken for 15 minutes (people already known keep working). */
const newByIp = new Map();
const newHits = [];
let newRaidUntil = 0;
function newProfileBlocked(ip) {
  const now = Date.now();
  if (newRaidUntil > now) return true;
  const l = (newByIp.get(ip) || []).filter((t) => now - t < 600000);
  if (l.length >= 6) { newByIp.set(ip, l); return true; }
  while (newHits.length && now - newHits[0] > 60000) newHits.shift();
  newHits.push(now);
  if (newHits.length > 40) { newRaidUntil = now + 15 * 60000; newHits.length = 0; console.log('[presence] raid mode: no new profiles for 15 minutes'); return true; }
  l.push(now); newByIp.set(ip, l);
  if (newByIp.size > 20000) newByIp.clear();
  return false;
}
router.post('/ping', express.json({ limit: '4mb' }), (req, res) => {
  const b = req.body || {};
  const id = clean(b.id, 64);
  if (!id) return res.status(400).json({ ok: false });
  const ip = clientIp(req);
  if (settings().bannedDevices.includes(ipHash(ip))) return res.status(403).json({ ok: false });
  if (b.name && hasSlur(String(b.name))) return res.status(403).json({ ok: false, error: 'that name is not allowed' });
  const now = Date.now();
  if (!people.has(id) && newProfileBlocked(ip)) return res.status(429).json({ ok: false, error: 'too many new profiles right now' });
  const prev = people.get(id) || {};
  let pfp = prev.pfp || '';
  if (typeof b.pfp === 'string' && b.pfp.startsWith('data:')) pfp = saveAvatar(b.pfp) || pfp;
  else if (b.pfp === '') pfp = '';
  const p = {
    uid: prev.uid || uidOf(id),
    name: clean(b.name, 24) || 'anon',
    bio: clean(b.bio, 140),
    pfp,
    border: isBorder(b.border) ? b.border : (prev.border || 'none'),
    last: now,
    first: prev.first || now,
    act: prev.act || null,
  };
  if (p.name !== prev.name || p.bio !== prev.bio || p.pfp !== prev.pfp || p.border !== prev.border || !prev.uid) dirty = true;
  people.set(id, p);
  const online = [...people.values()].filter((x) => now - x.last < ONLINE_MS).length;
  res.json({ ok: true, online, uid: p.uid, pfp: p.pfp || null });
});

/* Activity status, Discord style: each page says what this device is
   doing (playing a game, listening, watching...). Coarse on purpose - the
   proxy says "browsing the web", never which site. People can turn it off
   in Settings, which sends kind "". */
const ACT_KINDS = ['playing', 'games', 'listening', 'watching', 'searching', 'browsing', 'chatting', 'vm', 'studio', 'apps'];
router.post('/activity', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const p = people.get(clean(b.id, 64));
  if (!p) return res.status(404).json({ ok: false });
  const kind = ACT_KINDS.includes(b.kind) ? b.kind : '';
  const detail = kind ? clean(b.detail, 60) : '';
  const cur = p.act || {};
  if (!kind) p.act = null;
  else if (cur.k !== kind || cur.d !== detail) p.act = { k: kind, d: detail, at: Date.now() };
  p.last = Date.now();
  res.json({ ok: true });
});

router.get('/', (req, res) => {
  const now = Date.now();
  const list = [...people.values()]
    .filter((p) => now - p.last < LIST_MS)
    .sort((a, b) => b.last - a.last)
    .slice(0, 60)
    .map((p) => card(p, now));
  res.json({ online: list.filter((p) => p.online).length, people: list });
});

router.get('/u/:uid', (req, res) => {
  const uid = clean(req.params.uid, 16);
  const p = [...people.values()].find((x) => x.uid === uid);
  if (!p) return res.status(404).json({ ok: false });
  const now = Date.now();
  res.json({ ok: true, ...card(p, now), since: p.first, clips: clipsBy(uid) });
});

export function profileByDevice(id) { return people.get(id) || null; }
/* Picture and border for a chat name, newest profile first (leaderboard). */
/* Profile name for a device id (sp-device-id), for the leaderboard: most
   people fill in the Create Profile popup but never chat, so they have no
   chat name (2026-11-15). */
export function nameById(id) {
  const p = people.get(String(id || '').slice(0, 64));
  return p && p.name && p.name !== 'anon' ? String(p.name).slice(0, 24) : '';
}
export function pfpByName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  let best = null;
  for (const p of people.values()) if (p.name && p.name.toLowerCase() === n && (!best || p.last > best.last)) best = p;
  return best ? { pfp: best.pfp || '', border: best.border || 'none' } : null;
}

/* Used only by the admin panel. */
export const presenceAdmin = {
  list() {
    const now = Date.now();
    return [...people.values()].sort((a, b) => b.last - a.last).map((p) => ({ ...card(p, now), since: p.first }));
  },
  online() { const now = Date.now(); return [...people.values()].filter((p) => now - p.last < ONLINE_MS).length; },
  total() { return people.size; },
  forget(uid) {
    for (const [id, p] of people) { if (p.uid === uid) { people.delete(id); dirty = true; return true; } }
    return false;
  },
  clearOffline(days = 7) {
    const cut = Date.now() - days * 86400000; let n = 0;
    for (const [id, p] of people) { if (p.last < cut) { people.delete(id); n++; } }
    if (n) dirty = true;
    return n;
  },
};

export default router;
