import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { settings, setSettings, clientIp, ipHash } from '../site-settings.js';
import { hasSlur, plain } from '../slurs.js';
import { timingSafeEqual } from 'node:crypto';
import { setCallCheck, callRoster } from './voice.js';

const router = express.Router();
const HERE = dirname(fileURLToPath(import.meta.url));

/* Chat messages, stored by this server.
 *
 * They used to be WordPress comments on the chat page (post 97). WordPress is
 * gone, so the messages live in a JSON file here instead, and the chat page's
 * old read - GET /wp-json/wp/v2/comments?post=97 - is still answered by
 * commentsFeed below in the same shape WordPress used.
 *
 * Round three (2026-10-27): images and GIFs, replies, reactions, edits,
 * polls, typing, search and scroll-back. Every change to a message bumps a
 * revision counter, so a poll asks "what changed since revision N" and gets
 * new lines, edits, reactions and votes in one small answer.
 */

const POST_ID = 97;                 // the chat page; the only "post" with comments
const MAX_LEN = 2000;
const MAX_LINES = 40;
const MIN_GAP_MS = 250;             // the quickest two messages from one device can be
const KEEP = 3000;                  // oldest messages drop off past this
const MAX_ATT = 6;                  // pictures per message
const UPLOAD_MAX = 25 * 1024 * 1024;  // the biggest kind (video); each kind has its own limit below
/* 2026-11-14: videos and audio too. Limits per kind, checked on the real
   file contents (sniff), never on what the browser says it is. */
const KIND_MAX = { img: 8 * 1024 * 1024, aud: 15 * 1024 * 1024, vid: 25 * 1024 * 1024 };
const VIDEO_EXT = ['mp4', 'webm'], AUDIO_EXT = ['mp3', 'm4a', 'ogg', 'wav', 'weba'];
const MEDIA_CAP = 4 * 1024 ** 3;    // uploads stop past 4 GB of pictures on disk
const REMOTE_MAX = 15 * 1024 * 1024;

const FILE = process.env.CHAT_FILE || join(HERE, '..', 'data', 'chat.json');
/* Pictures people upload. Named by their own SHA-1, so the same picture sent
   twice is stored once, and the name never changes: Cloudflare can keep a
   copy for a year. */
export const MEDIA_DIR = process.env.CHAT_MEDIA_DIR || join(HERE, '..', '..', 'data', 'chat-media');

/* Rooms. '' is #general - public, stored in chat.json as it always was.
   Every other room is a DM or a group chat, readable and writable only by
   its members, stored with the chat identities in chat-rooms.json. Each
   room has its own messages, ids and deletion list; the revision counter
   is shared. Not end-to-end encrypted: whoever runs this server can read
   the file. */
const ROOMS_FILE = process.env.CHAT_ROOMS_FILE || join(dirname(FILE), 'chat-rooms.json');
const MAX_MEMBERS = 25;
function mkRoom(o) {
  const r = Object.assign({}, o);
  r.messages = Array.isArray(r.messages) ? r.messages : [];
  r.nextId = r.messages.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;
  r.removed = [];
  return r;
}
let generalMsgs = [];
try { generalMsgs = JSON.parse(readFileSync(FILE, 'utf8')); } catch { generalMsgs = []; }
if (!Array.isArray(generalMsgs)) generalMsgs = [];
const general = mkRoom({ id: '', kind: 'general', messages: generalMsgs });
const rooms = new Map();
const servers = new Map();           // id -> server (see "servers" below)
/* Chat identities: pid -> {pid, name, color, last}. A pid is a hash of the
   device's private token, so it can be shown to everyone while only that
   device can act as it. */
const people = new Map();
/* Staff: pid -> 'owner' | 'superadmin' | 'admin'. Shown as a tag next to the
   name. Each rank can act on the ranks below it and never on its own. */
const roles = new Map();
const mutes = new Map();             // pid -> muted until (ms)
let auditHook = null;                // (pid, action, detail) - staff log (set by routes/xenon.js)
let mentionHook = null;              // (msg, room) - Xenon AI answering @Xenon (set by routes/xenon.js)
const logMod = (pid, action, detail) => { try { if (auditHook) auditHook(pid, action, detail); } catch {} };
const devOf = new Map();             // pid -> last device it posted from (for ban by name)
let banRequestHook = null;           // (req) - non-owner bans wait for the owner (set by routes/xenon.js)
let tagHook = null;                  // pid -> {label,color,font,fx} | null (set by routes/xenon.js)
try {
  const j = JSON.parse(readFileSync(ROOMS_FILE, 'utf8'));
  for (const r of j.rooms || []) rooms.set(r.id, mkRoom(r));
  for (const p of j.people || []) people.set(p.pid, p);
  for (const sv of j.servers || []) servers.set(sv.id, sv);
  for (const [k, v] of Object.entries(j.roles || {})) roles.set(k, v);
  for (const [k, v] of Object.entries(j.mutes || {})) if (v > Date.now()) mutes.set(k, v);
} catch {}
/* supreme sits between super admin and owner (2026-11-05: Typicallyome). */
const RANK = { admin: 1, superadmin: 2, supreme: 3, owner: 4 };
const rankOf = (pid) => (pid && RANK[roles.get(pid)]) || 0;
/* The site owner's chat identity, from .env, so it survives a lost data file. */
if (process.env.CHAT_OWNER_PID && ![...roles.values()].includes('owner')) roles.set(process.env.CHAT_OWNER_PID, 'owner');
/* SUPREME identities from .env (comma-separated pids). Applied at every
   start, so to take Supreme away for good, remove the pid there too. */
for (const id of String(process.env.CHAT_SUPREME_PID || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  if (roles.get(id) !== 'owner') roles.set(id, 'supreme');
}
const allRooms = () => [general, ...rooms.values()];
if (process.env.CHAT_OWNER_PID) {
  const op = process.env.CHAT_OWNER_PID, on = (people.get(op) || {}).name;
  const devs = new Set(general.messages.filter((m) => m.pid === op && m.dev).map((m) => m.dev));
  for (const m of general.messages) if (!m.pid && on && m.name === on && devs.has(m.dev)) m.pid = op;
}
let rev = allRooms().reduce((m, r) => r.messages.reduce((x, c) => Math.max(x, c.rv || 0), m), 0);
/* A client that polled a previous run of this server cannot trust its
   revision number (deletions are only remembered in memory), so it starts
   over when this changes. */
const BOOT = randomBytes(6).toString('hex');
function touch(m) { m.rv = ++rev; }

/* Write to a temp file and rename, so a crash mid-write cannot leave a
   truncated file that would lose every message on the next start. Batched:
   a burst of reactions is one write, not twenty. */
let saveTimer = null;
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(data));
  renameSync(file + '.tmp', file);
}
function save() {
  try {
    writeJson(FILE, general.messages);
    writeJson(ROOMS_FILE, {
      rooms: [...rooms.values()].map((r) => ({ id: r.id, kind: r.kind, name: r.name, members: r.members, owner: r.owner, created: r.created, messages: r.messages, server: r.server, ckind: r.ckind, topic: r.topic })),
      servers: [...servers.values()],
      people: [...people.values()],
      roles: Object.fromEntries(roles),
      mutes: Object.fromEntries(mutes),
    });
  } catch (e) {
    console.warn('[chat] could not save: ' + e.message);
  }
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 600);
}
process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); save(); } });

/* Ids that have been deleted, so a client that already drew them can take
   them down on its next poll. */
function noteRemoved(room, id) {
  room.removed.push({ id, at: Date.now(), rv: ++rev });
  if (room.removed.length > 500) room.removed.splice(0, room.removed.length - 500);
}
function removedSince(room, since) {
  if (!Number.isFinite(since)) return [];
  return room.removed.filter((r) => Date.now() - r.at < 3600000).map((r) => r.id);
}

const slowSeen = new Map();
const tapSeen = new Map();

function gap(map, key, ms) {
  const now = Date.now();
  const prev = map.get(key) || 0;
  if (now - prev < ms) return true;
  map.set(key, now);
  /* Keep the map from growing without bound on a long-running server. */
  if (map.size > 5000) {
    for (const [k, t] of map) { if (now - t > 60000) map.delete(k); }
  }
  return false;
}
/* Same address the bans use: Cloudflare's CF-Connecting-IP first. The first
   X-Forwarded-For entry is whatever the sender wrote, so it could be faked on
   every request to dodge the per-address limits (fixed 2026-11-15). */
const ipOf = (req) => clientIp(req);

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const fpOf = (token) => (token ? createHash('sha256').update(String(token)).digest('hex').slice(0, 24) : '');
const pidOf = (token) => (token ? createHash('sha256').update('pid:' + String(token)).digest('hex').slice(0, 16) : '');

/* The room a request is about: '' (or none) is #general, open to all. A
   private room answers only to its members. */
function roomOf(req, res, src) {
  const id = String((src && src.room) || '');
  if (!id) return general;
  const r = rooms.get(id);
  if (!r) { res.status(404).json({ error: 'that chat is gone' }); return null; }
  const pid = pidOf(src.token);
  if (r.server) {
    if (srvRank(servers.get(r.server), pid) < 0) { res.status(403).json({ error: 'you are not in that server' }); return null; }
    return r;
  }
  if (!pid || !r.members.includes(pid)) { res.status(403).json({ error: 'you are not in that chat' }); return null; }
  return r;
}
function seen(pid, name, color) {
  if (!pid) return;
  const p = people.get(pid) || { pid, first: Date.now() };
  if (name) p.name = name;
  if (color) p.color = color;
  p.last = Date.now();
  people.set(pid, p);
}
const cleanName = (v) => String(v || '').trim().slice(0, 24);

/* Slur filter lives in backend/slurs.js (shared with presence.js). */
/* Spam shapes the raid used: @everyone from non-staff, walls of random
   characters, one phrase repeated over and over. */
function spamShape(text) {
  if (/@(everyone|here)\b/i.test(text)) return 'only staff can ping everyone';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.some((w) => w.length > 60 && !/^https?:\/\//i.test(w))) return 'that looks like spam';
  if (words.length >= 12 && new Set(words.map((w) => w.toLowerCase())).size / words.length < 0.35) return 'that looks like spam';
  return '';
}

/* Raid mode (2026-11-15): the second raid came from 26 addresses with ~5
   messages each, under every per-address limit. So watch the whole chat:
   if brand-new profiles (first message under 10 minutes ago) send more than
   10 messages in a minute, new profiles can't post for 15 minutes. People
   who chatted before keep chatting. */
/* Anti-script (2026-11-15): every message needs a one-time ticket from
   GET /ticket (usable 1.5 s to 10 min after it was issued, by the same
   profile), a proof-of-work answer (sha256(salt:nonce) with BITS leading
   zero bits - about half a second in a browser, harder in raid mode), and
   real keystrokes for typed messages. Scripts that just POST /send fail.
   For 20 minutes after a restart, messages without a ticket still pass, so
   open tabs with the old page keep working until they refresh. */
const tickets = new Map();
const BITS = 14, RAID_BITS = 17;
/* The site has solved tickets since 2026-11-15, so no grace period: a
   restart must not open a window for scripts. */
const ENFORCE_AT = 0;
router.get('/ticket', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (burst('tk:' + ipOf(req), 15, 0)) return res.status(429).json({ error: 'slow down a moment' });
  const now = Date.now();
  if (tickets.size > 50000) for (const [k, t] of tickets) if (now - t.at > 600000) tickets.delete(k);
  const id = randomBytes(9).toString('hex');
  const salt = randomBytes(12).toString('hex');
  const bits = raidUntil > now ? RAID_BITS : BITS;
  tickets.set(id, { salt, at: now, pid: pidOf(String(req.query.token || '')), bits });
  res.json({ id, salt, bits });
});
function zeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } let x = b; while (!(x & 0x80)) { n++; x <<= 1; } break; }
  return n;
}
function proven(body, pid, text, att) {
  if (!body.ticket && Date.now() < ENFORCE_AT) return '';
  const t = tickets.get(String(body.ticket || ''));
  if (!body.ticket) return 'looolll you tried blud'; /* no ticket at all = a script */
  if (!t) return 'please refresh the page and try again';
  tickets.delete(String(body.ticket));
  const age = Date.now() - t.at;
  if (t.pid !== pid || age < 1500 || age > 600000) return 'please refresh the page and try again';
  if (zeroBits(createHash('sha256').update(t.salt + ':' + String(body.nonce)).digest()) < t.bits) return 'please refresh the page and try again';
  if (text && !(att && att.length) && !(Number(body.keys) >= 1)) return 'type your message in the box to send it';
  return '';
}
const freshHits = [];
let raidUntil = 0;
function isFresh(pid) {
  const p = people.get(pid);
  return !p || (p.first && Date.now() - p.first < 10 * 60000);
}
function raidCheck(pid) {
  const now = Date.now();
  if (!isFresh(pid)) return '';
  if (raidUntil > now) return 'looolll you tried blud';
  while (freshHits.length && now - freshHits[0] > 60000) freshHits.shift();
  freshHits.push(now);
  if (freshHits.length > 10) {
    raidUntil = now + 15 * 60000;
    freshHits.length = 0;
    console.log('[chat] raid mode on for 15 minutes');
    try { sysMessage(general, 'Raid mode is on for 15 minutes - new accounts can\'t post. Everyone else is fine.'); } catch {}
    return 'looolll you tried blud';
  }
  return '';
}

function starSlurs(text) {
  return String(text).replace(/\S+/g, (word) => (hasSlur(word) ? '*'.repeat(word.length) : word));
}
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : 0; };

function cleanText(v) {
  let t = String(v || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  t = t.split('\n').slice(0, MAX_LINES).join('\n').replace(/\n{4,}/g, '\n\n\n');
  return t.trim().slice(0, MAX_LEN);
}

function censor(text) {
  const S = settings();
  for (const w of S.words || []) {
    if (!w) continue;
    text = text.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => '*'.repeat(m.length));
  }
  return text;
}

/* Admin switches (site-settings.js), shared by everything that writes. */
function gate(req, res, name) {
  const S = settings();
  const dev = ipHash(clientIp(req));
  if (S.chatLocked) { res.status(403).json({ error: 'chat is locked right now' }); return null; }
  if (S.bannedDevices.includes(dev) || (name && S.bannedNames.includes(name.toLowerCase()))) {
    res.status(403).json({ error: 'you cannot post here' });
    return null;
  }
  return { S, dev };
}

/* ------------------------------------------------------------ pictures */

function sniff(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 10) { const g = b.toString('latin1', 0, 6); if (g === 'GIF87a' || g === 'GIF89a') return 'gif'; }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  /* video and audio */
  if (b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (/^(M4A |M4B |F4A )/.test(brand)) return 'm4a';
    if (/^(qt  )/.test(brand)) return '';            // QuickTime .mov: most browsers cannot play it
    return 'mp4';
  }
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.length > 4 && b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'mp3';
  return '';
}

/* Width and height from the file header, so the page can hold the space for
   a picture before it loads and the log does not jump. */
function dims(b, ext) {
  try {
    if (ext === 'png') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (ext === 'gif') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (ext === 'webp') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
        return { w: 1 + (((b2 & 0x3f) << 8) | b1), h: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
      }
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

let mediaUsed = 0;
try {
  for (const f of readdirSync(MEDIA_DIR)) mediaUsed += statSync(join(MEDIA_DIR, f)).size;
} catch {}

const upSeen = new Map();
router.post('/upload', express.raw({ type: () => true, limit: UPLOAD_MAX }), (req, res) => {
  const g = gate(req, res);
  if (!g) return;
  const now = Date.now();
  const recent = (upSeen.get(g.dev) || []).filter((t) => now - t < 600000);
  if (recent.length >= 120) return res.status(429).json({ error: 'too many pictures - wait a few minutes' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'that file is empty' });
  let ext = sniff(buf);
  if (!ext) return res.status(415).json({ error: 'that file type is not supported - send a picture, an MP4/WebM video, or MP3/M4A/OGG/WAV audio' });
  /* A WebM can be audio only (voice messages): the page says so with ?k=aud. */
  if (ext === 'webm' && req.query.k === 'aud') ext = 'weba';
  const kind = VIDEO_EXT.includes(ext) ? 'vid' : AUDIO_EXT.includes(ext) ? 'aud' : 'img';
  if (buf.length > KIND_MAX[kind]) return res.status(413).json({ error: (kind === 'vid' ? 'videos' : kind === 'aud' ? 'audio files' : 'pictures') + ' can be up to ' + (KIND_MAX[kind] / 1048576) + ' MB' });
  const name = createHash('sha1').update(buf).digest('hex') + '.' + ext;
  const file = join(MEDIA_DIR, name);
  if (!existsSync(file)) {
    if (mediaUsed + buf.length > MEDIA_CAP) return res.status(507).json({ error: 'picture storage is full - tell the owner' });
    try {
      mkdirSync(MEDIA_DIR, { recursive: true });
      writeFileSync(file, buf);
      mediaUsed += buf.length;
    } catch (e) {
      console.warn('[chat] could not store a picture: ' + e.message);
      return res.status(500).json({ error: 'could not store that picture' });
    }
  }
  recent.push(now);
  upSeen.set(g.dev, recent);
  const d = kind === 'img' ? dims(buf, ext) || {} : {};
  res.json({ ok: true, u: '/chatmedia/' + name, k: kind === 'img' ? (ext === 'gif' ? 'gif' : 'img') : kind, w: d.w || 0, h: d.h || 0, size: buf.length });
});

/* GIFs and meme templates from other sites come through here, so the page
   only ever talks to this server (school filters judge every host on its
   own) and Cloudflare keeps a copy of each one. Only these hosts. */
const REMOTE_HOSTS = /^(nekos\.best|media[0-9]?\.giphy\.com|i\.giphy\.com|([a-z0-9-]+\.)*klipy\.com)$/i;
router.get(/^\/gif\/([a-z0-9.-]+)\/([A-Za-z0-9._~=\/-]+)$/i, async (req, res) => {
  const host = req.params[0], path = req.params[1];
  if (!REMOTE_HOSTS.test(host) || path.includes('..') || !/\.(gif|webp|jpe?g|png)$/i.test(path)) return res.status(404).end();
  try {
    const up = await fetch('https://' + host + '/' + path, {
      headers: { 'user-agent': 'XenonChat/1.0 (+https://zpack.beauty)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!up.ok) return res.status(up.status === 404 ? 404 : 502).end();
    if (Number(up.headers.get('content-length') || 0) > REMOTE_MAX) return res.status(413).end();
    const buf = Buffer.from(await up.arrayBuffer());
    const ext = buf.length <= REMOTE_MAX ? sniff(buf) : '';
    if (!ext) return res.status(415).end();
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(ext === 'jpg' ? 'jpeg' : ext).end(buf);
  } catch {
    res.status(502).end();
  }
});

/* An attachment is either a picture uploaded here or a GIF/meme from one of
   the hosts above, by its path on this server. Anything else is dropped. */
function cleanAtt(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_ATT)) {
    if (!a || typeof a !== 'object') continue;
    const u = String(a.u || '');
    let m, k = 'img';
    if ((m = /^\/chatmedia\/([a-f0-9]{40}\.(png|jpg|gif|webp|mp4|webm|mp3|m4a|ogg|wav|weba))$/.exec(u))) {
      if (!existsSync(join(MEDIA_DIR, m[1]))) continue;
      if (m[2] === 'gif') k = 'gif';
      else if (VIDEO_EXT.includes(m[2])) k = 'vid';
      else if (AUDIO_EXT.includes(m[2])) k = 'aud';
    } else if ((m = /^\/api\/chat\/gif\/([a-z0-9.-]+)\/[A-Za-z0-9._~=\/-]+$/i.exec(u))) {
      if (!REMOTE_HOSTS.test(m[1]) || u.includes('..')) continue;
      k = /\.gif$/i.test(u) ? 'gif' : 'img';
    } else continue;
    const o = { u, k };
    const w = clampInt(a.w, 1, 20000), h = clampInt(a.h, 1, 20000);
    if (w && h) { o.w = w; o.h = h; }
    if (a.sp) o.sp = 1;
    if (k === 'vid' || k === 'aud') {
      const n = String(a.n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
      if (n) o.n = n;
      const d = Number(a.d);
      if (d > 0 && d < 36000) o.d = Math.round(d * 10) / 10;
      if (a.vm) o.vm = 1;                       // a voice message recorded in chat
    }
    out.push(o);
  }
  return out;
}

function cleanPoll(p) {
  if (!p || typeof p !== 'object') return null;
  const q = censor(String(p.q || '').replace(/\s+/g, ' ').trim().slice(0, 200));
  const opts = (Array.isArray(p.opts) ? p.opts : [])
    .map((o) => censor(String(o || '').replace(/\s+/g, ' ').trim().slice(0, 80)))
    .filter(Boolean).slice(0, 10);
  if (!q || opts.length < 2) return null;
  return { q, opts: opts.map((t) => ({ t, v: [] })) };
}

const snippet = (m) => String(m.text || (m.poll ? 'poll: ' + m.poll.q : (m.att && m.att.length ? ({ vid: '[video]', aud: m.att[0].vm ? '[voice message]' : '[audio]', gif: '[GIF]' }[m.att[0].k] || '[picture]') : ''))).replace(/\s+/g, ' ').slice(0, 140);

/* What a client sees of a message: fingerprints stay here; it is told only
   which lines, reactions and votes are its own. */
const view = (fp) => (m) => {
  const c = { id: m.id, name: m.name, text: m.text, date: m.date };
  for (const k of ['color', 'vfx', 'border', 'bot', 'att', 'reply', 'ed', 'me']) if (m[k] !== undefined) c[k] = m[k];
  c.mine = Boolean(fp && m.owner === fp);
  if (m.pid) {
    c.pid = m.pid;
    if (roles.has(m.pid)) c.role = roles.get(m.pid);
    /* Custom name tags and premium (routes/xenon.js) - looked up live, so a
       tag change shows on old lines too once touchAuthor() marks them. */
    if (tagHook) { const t = tagHook(m.pid); if (t) c.tag = t; }
  }
  if (m.sys) c.sys = true;
  if (m.re) {
    c.re = Object.entries(m.re).map(([e, who]) => ({ e, n: who.length, me: Boolean(fp) && who.some((w) => w.f === fp), by: who.slice(-12).map((w) => w.n) }));
  }
  if (m.poll) {
    c.poll = {
      q: m.poll.q,
      opts: m.poll.opts.map((o) => ({ t: o.t, n: o.v.length, me: Boolean(fp) && o.v.includes(fp) })),
      total: m.poll.opts.reduce((s, o) => s + o.v.length, 0),
    };
  }
  return c;
};

/* ------------------------------------------------------------ typing */
const typing = new Map();            // room + "\n" + name -> last keypress
function typers(room) {
  const now = Date.now(), out = [];
  for (const [k, t] of typing) {
    if (now - t >= 6000) { typing.delete(k); continue; }
    const at = k.indexOf('\n');
    if (k.slice(0, at) === room.id) out.push(k.slice(at + 1));
  }
  return out;
}
router.post('/typing', express.json({ limit: '2kb' }), (req, res) => {
  const room = roomOf(req, res, req.body || {});
  if (!room) return;
  const name = cleanName(req.body && req.body.name);
  if (name) typing.set(room.id + '\n' + name, Date.now());
  res.json({ ok: true });
});

/* ------------------------------------------------------------ writing */

/* Spam guard: five messages in five seconds per device, and a looser cap per
   address - a whole school can share one. */
const bursts = new Map();
function burst(key, max, gapMs) {
  const now = Date.now();
  const list = (bursts.get(key) || []).filter((t) => now - t < 5000);
  const over = list.length >= max || (gapMs > 0 && list.length > 0 && now - list[list.length - 1] < gapMs);
  if (!over) list.push(now);
  bursts.set(key, list);
  if (bursts.size > 5000) { for (const [k, l] of bursts) { if (!l.length || now - l[l.length - 1] > 10000) bursts.delete(k); } }
  return over;
}

/* Flood guard (2026-11-15, after a raid of ~500 lorem-ipsum messages from one
   address through 38 throwaway profiles in 6 minutes). The 5-second burst
   caps above didn't catch it: the per-device cap resets with every new
   profile, and 25 per 5 s per address is 5 a second. On top of them:
   - 45 messages a minute per address (a whole school can share one);
   - at most 12 different profiles posting from one address in 10 minutes;
   - an address that keeps hitting these limits is timed out for an hour
     (in memory only, so a restart or the hour clears it; no permanent ban). */
const windows = new Map();
function overWindow(key, max, ms) {
  const now = Date.now();
  const list = (windows.get(key) || []).filter((t) => now - t < ms);
  const over = list.length >= max;
  if (!over) list.push(now);
  windows.set(key, list);
  if (windows.size > 20000) { for (const [k, l] of windows) { if (!l.length || now - l[l.length - 1] > 600000) windows.delete(k); } }
  return over;
}
const idents = new Map();   /* ip -> Map(identity -> last seen) */
const timeouts = new Map(); /* ip -> until */
function floodBlocked(ip, ident) {
  const now = Date.now();
  if ((timeouts.get(ip) || 0) > now) return 'looolll you tried blud';
  const seen = idents.get(ip) || new Map();
  for (const [k, t] of seen) if (now - t > 600000) seen.delete(k);
  if (!seen.has(ident) && seen.size >= 12) return strike(ip) || 'too many new profiles from your network - try again in a few minutes';
  if (overWindow('min:' + ip, 45, 60000)) return strike(ip) || 'slow down a moment';
  seen.set(ident, now); idents.set(ip, seen);
  if (idents.size > 20000) idents.clear();
  return null;
}
function strike(ip) {
  if (overWindow('strike:' + ip, 20, 300000)) {
    timeouts.set(ip, Date.now() + 3600000);
    console.log('[chat] flood: timed out an address for 1 hour');
    return 'looolll you tried blud';
  }
  return null;
}

router.post('/send', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  if (burst('ip:' + ipOf(req), 25, 0) || burst('fp:' + (fpOf(body.token) || ipOf(req)), 5, MIN_GAP_MS)) {
    return res.status(429).json({ error: 'slow down a moment' });
  }
  const flood = floodBlocked(ipOf(req), fpOf(body.token) || 'anon');
  if (flood) return res.status(429).json({ error: flood });
  const room = roomOf(req, res, body);
  if (!room) return;
  const name = cleanName(plain(body.name));
  /* zalgo: drop stacks of combining marks (keeps normal accents) */
  let text = cleanText(String(body.text || '').replace(/\p{M}{2,}/gu, ''));
  const att = cleanAtt(body.att);
  const poll = cleanPoll(body.poll);
  if (!name) return res.status(400).json({ error: 'no name set' });
  if (hasSlur(name)) return res.status(400).json({ error: 'that name is not allowed - change it in your profile' });
  if (!text && !att.length && !poll) return res.status(400).json({ error: 'empty message' });
  const senderPid = pidOf(String(body.token || ''));
  const staff = rankOf(senderPid) > 0;
  if (text && !staff) { const sp = spamShape(text); if (sp) return res.status(400).json({ error: sp }); }
  if (!staff) { const pv = proven(body, senderPid, text, att); if (pv) return res.status(400).json({ error: pv }); }
  if (!staff) { const rc = raidCheck(senderPid); if (rc) return res.status(429).json({ error: rc }); }
  if (text) text = starSlurs(text);

  const g = gate(req, res, name);
  if (!g) return;
  if (g.S.slowSec > 0) {
    const last = slowSeen.get(g.dev) || 0;
    if (Date.now() - last < g.S.slowSec * 1000) return res.status(429).json({ error: 'slow mode: one message every ' + g.S.slowSec + 's' });
    slowSeen.set(g.dev, Date.now());
  }
  text = censor(text);

  /* Cosmetics travel with the message so old lines keep the colour they were
     sent with. Avatars deliberately do NOT - a data URL per message would
     grow the file without bound; the client resolves those from presence. */
  const colour = /^#[0-9a-f]{6}$/i.test(String(body.color || '')) ? String(body.color) : '';
  const vfx = String(body.vfx || '').replace(/[^a-z-]/g, '').slice(0, 24);
  const border = String(body.border || '').replace(/[^a-z0-9-]/g, '').slice(0, 32);

  /* Who may edit or delete this later. There are no accounts here, so the
     client keeps a random token in localStorage and we store only its hash -
     enough to stop someone touching other people's lines, not a claim about
     identity. */
  const token = String(body.token || '');
  const spid = pidOf(token);
  const until = mutes.get(spid) || 0;
  if (until > Date.now()) return res.status(403).json({ error: 'you are muted for ' + Math.ceil((until - Date.now()) / 60000) + ' more min' });
  if (room.server) {
    const sv = servers.get(room.server), t = ((sv && sv.mutes) || {})[spid] || 0;
    if (t > Date.now()) return res.status(403).json({ error: 'you are timed out in this server for ' + Math.ceil((t - Date.now()) / 60000) + ' more min' });
    if (room.ckind === 'voice') return res.status(400).json({ error: 'that is a voice channel' });
  }
  const taken = staffName(name);
  if (taken && taken !== spid) return res.status(403).json({ error: 'that name belongs to a staff member - pick another in Settings' });
  const msg = { id: room.nextId++, name, text, date: new Date().toISOString().slice(0, 19), dev: g.dev };
  if (token) { msg.owner = fpOf(token); msg.pid = pidOf(token); seen(msg.pid, name, colour); if (g.dev) devOf.set(msg.pid, g.dev); }
  if (colour) msg.color = colour;
  if (vfx) msg.vfx = vfx;
  if (border) msg.border = border;
  if (body.bot === true) msg.bot = true;
  if (body.me === true && text) msg.me = true;
  if (att.length) msg.att = att;
  if (poll) msg.poll = poll;
  const rid = parseInt(body.reply, 10);
  if (Number.isFinite(rid)) {
    const t = room.messages.find((m) => m.id === rid);
    if (t) msg.reply = { id: t.id, name: t.name, text: snippet(t) };
  }
  touch(msg);
  room.messages.push(msg);
  typing.delete(room.id + '\n' + name);
  if (room.messages.length > KEEP) room.messages = room.messages.slice(-KEEP);
  persist();
  if (mentionHook && room === general && !msg.bot) { try { mentionHook(msg); } catch {} }
  return res.json({ ok: true, id: msg.id, rev });
});

function ownMessage(req, res, mod) {
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  const token = String(b.token || '');
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'which message?' }); return null; }
  if (!token) { res.status(403).json({ error: 'not yours' }); return null; }
  const room = roomOf(req, res, b);
  if (!room) return null;
  const i = room.messages.findIndex((m) => m.id === id);
  if (i === -1) { res.status(404).json({ error: 'already gone' }); return null; }
  const m = room.messages[i];
  const own = m.owner && m.owner === fpOf(token);
  const srvMod = mod && room.server && (() => { const sv = servers.get(room.server); const mine = srvRank(sv, pidOf(token)); const theirs = !m.pid ? 0 : sv.owner === m.pid ? 3 : ({ mod: 1, admin: 2 }[(sv.roles || {})[m.pid]] || 0); return mine >= 1 && mine > theirs; })();
  if (!own && !srvMod && !(mod && outranks(pidOf(token), m))) { res.status(403).json({ error: 'not yours' }); return null; }
  return { i, m, room, own };
}
/* Whether a staff member may act on a message: the author must rank below them. */
function outranks(pid, m) {
  const r = rankOf(pid);
  if (!r) return false;
  if (r === RANK.owner) return true;
  return rankOf(m.pid) < r;
}
function staffName(name) {
  const n = String(name || '').toLowerCase();
  for (const [pid] of roles) { const p = people.get(pid); if (p && p.name && p.name.toLowerCase() === n) return pid; }
  return '';
}

/* Delete one of your own messages. */
router.post('/delete', express.json({ limit: '4kb' }), (req, res) => {
  const own = ownMessage(req, res, true);
  if (!own) return;
  if (!own.own) logMod(pidOf(String((req.body || {}).token || '')), 'chat_delete', { name: own.m.name, text: String(own.m.text || '').slice(0, 200) });
  own.room.messages.splice(own.i, 1);
  noteRemoved(own.room, own.m.id);
  persist();
  return res.json({ ok: true, id: own.m.id });
});

/* Edit one of your own messages. Pictures and polls stay as they were. */
router.post('/edit', express.json({ limit: '16kb' }), (req, res) => {
  const own = ownMessage(req, res);
  if (!own) return;
  if (!gate(req, res, own.m.name)) return;
  const text = censor(cleanText(req.body.text));
  if (!text && !(own.m.att && own.m.att.length) && !own.m.poll) return res.status(400).json({ error: 'nothing left - delete it instead' });
  if (text === own.m.text) return res.json({ ok: true });
  own.m.text = text;
  own.m.ed = new Date().toISOString().slice(0, 19);
  touch(own.m);
  persist();
  return res.json({ ok: true, rev });
});

/* Toggle a reaction. Anyone with a token may react; one of each emoji per
   person per message. */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
router.post('/react', express.json({ limit: '2kb' }), (req, res) => {
  if (gap(tapSeen, ipOf(req), 120)) return res.status(429).json({ error: 'slow down a moment' });
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  const e = String(b.e || '').trim();
  const fp = fpOf(b.token);
  if (!fp) return res.status(403).json({ error: 'no token' });
  /* :name: is a custom picture emoji (2026-11-12). */
  const custom = /^:[a-z0-9_]{1,30}:$/.test(e);
  if (!e || (!custom && (e.length > 16 || !EMOJI.test(e) || /[<>&"'\sA-Za-z]/.test(e)))) return res.status(400).json({ error: 'not an emoji' });
  const name = cleanName(b.name) || 'someone';
  if (!gate(req, res, name)) return;
  const room = roomOf(req, res, b);
  if (!room) return;
  const m = room.messages.find((x) => x.id === id);
  if (!m) return res.status(404).json({ error: 'that message is gone' });
  m.re = m.re || {};
  const list = m.re[e] || [];
  const i = list.findIndex((w) => w.f === fp);
  if (i >= 0) list.splice(i, 1);
  else {
    if (!m.re[e] && Object.keys(m.re).length >= 20) return res.status(400).json({ error: 'too many different reactions on that one' });
    list.push({ f: fp, n: name });
  }
  if (list.length) m.re[e] = list; else delete m.re[e];
  if (!Object.keys(m.re).length) delete m.re;
  touch(m);
  persist();
  return res.json({ ok: true, rev });
});

/* One vote per person per poll; voting for your own pick again takes it back. */
router.post('/vote', express.json({ limit: '2kb' }), (req, res) => {
  if (gap(tapSeen, ipOf(req), 120)) return res.status(429).json({ error: 'slow down a moment' });
  const b = req.body || {};
  const fp = fpOf(b.token);
  if (!fp) return res.status(403).json({ error: 'no token' });
  if (!gate(req, res, cleanName(b.name))) return;
  const room = roomOf(req, res, b);
  if (!room) return;
  const m = room.messages.find((x) => x.id === parseInt(b.id, 10));
  if (!m || !m.poll) return res.status(404).json({ error: 'that poll is gone' });
  const k = parseInt(b.opt, 10);
  if (!(k >= 0 && k < m.poll.opts.length)) return res.status(400).json({ error: 'which option?' });
  const had = m.poll.opts[k].v.includes(fp);
  m.poll.opts.forEach((o) => { o.v = o.v.filter((f) => f !== fp); });
  if (!had) m.poll.opts[k].v.push(fp);
  touch(m);
  persist();
  return res.json({ ok: true, rev });
});

/* ------------------------------------------------------------ reading */

router.get('/list', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fp = fpOf(req.query.token);
  const S = settings();
  const room = roomOf(req, res, req.query);
  if (!room) return;
  const messages = room.messages, removed = room.removed;
  if (room !== general) seen(pidOf(req.query.token));
  const base = {
    boot: BOOT, rev,
    latest: messages.length ? messages[messages.length - 1].id : 0,
    pinned: room === general ? S.pinned || '' : '', locked: S.chatLocked, typing: typers(room),
  };
  const v = view(fp);

  /* What changed since revision N: new lines, edits, reactions, votes. */
  if (req.query.rev !== undefined) {
    const r = parseInt(req.query.rev, 10);
    if (Number.isFinite(r) && r <= rev && String(req.query.boot || '') === BOOT) {
      return res.json(Object.assign(base, {
        messages: messages.filter((m) => (m.rv || 0) > r).map(v),
        removed: removed.filter((x) => x.rv > r).map((x) => x.id),
      }));
    }
    base.reset = true;
  }

  /* Scrolling back: the page of messages before an id. */
  if (req.query.before !== undefined) {
    const b = parseInt(req.query.before, 10);
    const n = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 60));
    const older = messages.filter((m) => m.id < b);
    const page = older.slice(-n);
    return res.json(Object.assign(base, { messages: page.map(v), removed: [], more: older.length > page.length }));
  }

  /* The older client: everything after an id. */
  const since = parseInt(req.query.since, 10);
  if (Number.isFinite(since) && req.query.rev === undefined) {
    return res.json(Object.assign(base, { messages: messages.filter((m) => m.id > since).map(v), removed: removedSince(room, since) }));
  }

  const n = Math.max(1, Math.min(300, parseInt(req.query.limit, 10) || 80));
  const page = messages.slice(-n);
  return res.json(Object.assign(base, { messages: page.map(v), removed: [], more: messages.length > page.length }));
});

/* Search the whole history: words in the text, or from:name. */
router.get('/search', (req, res) => {
  res.set('Cache-Control', 'no-store');
  let q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  let from = '';
  const fm = /(?:^|\s)from:(\S+)/.exec(q);
  if (fm) { from = fm[1]; q = q.replace(fm[0], ' ').trim(); }
  if (q.length < 2 && !from) return res.json({ results: [] });
  const room = roomOf(req, res, req.query);
  if (!room) return;
  const messages = room.messages;
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < 50; i--) {
    const m = messages[i];
    if (from && m.name.toLowerCase() !== from) continue;
    if (q && !String(m.text || '').toLowerCase().includes(q) && !(m.poll && m.poll.q.toLowerCase().includes(q))) continue;
    out.push(m);
  }
  res.json({ results: out.map(view(fpOf(req.query.token))) });
});

/* ------------------------------------------------------------ DMs and groups */

function sysMessage(room, text) {
  const msg = { id: room.nextId++, name: 'Xenon', text: String(text).slice(0, MAX_LEN), date: new Date().toISOString().slice(0, 19), bot: true, sys: true, color: '#c084fc' };
  touch(msg);
  room.messages.push(msg);
  persist();
  return msg.id;
}
const nameOf = (pid) => (people.get(pid) || {}).name || 'someone';
function roomCard(r, pid) {
  const last = r.messages[r.messages.length - 1];
  return {
    id: r.id, kind: r.kind, name: r.name || '', owner: r.owner === pid,
    members: r.members.map((p) => ({ pid: p, name: nameOf(p), color: (people.get(p) || {}).color || '', online: Date.now() - ((people.get(p) || {}).last || 0) < 120000, me: p === pid })),
    latest: last ? last.id : 0,
    call: callRoster(r.id),
    last: last ? { name: last.name, text: snippet(last), date: last.date, mine: last.pid === pid } : null,
    at: last ? last.date : r.created,
  };
}
function me(req, res, src) {
  const pid = pidOf(src && src.token);
  if (!pid) { res.status(403).json({ error: 'no token' }); return ''; }
  return pid;
}

/* Only a chat's members can enter its call. */
setCallCheck((id, token) => {
  const r = rooms.get(id); const pid = pidOf(token);
  if (r && r.server) return srvRank(servers.get(r.server), pid) >= 0;
  return Boolean(r && pid && r.members.includes(pid));
});

/* Who this device is, under the name it chats as. Called on page load. */
router.post('/hello', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  const colour = /^#[0-9a-f]{6}$/i.test(String(b.color || '')) ? String(b.color) : '';
  const nm = cleanName(b.name);
  const taken = staffName(nm);
  seen(pid, taken && taken !== pid ? '' : nm, colour);
  persist();
  res.json({ ok: true, pid, role: roles.get(pid) || '', taken: Boolean(taken && taken !== pid) });
});

/* ------------------------------------------------------------ staff */

function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length >= 64 && timingSafeEqual(x, y);
}
const claimFails = new Map();
/* Move everything an identity owns - its lines, DMs, groups, name and rank -
   onto a new device's identity. */
function takeOver(old, pid) {
  for (const r of allRooms()) {
    for (const m of r.messages) if (m.pid === old) { m.pid = pid; touch(m); }
    if (r.members) r.members = [...new Set(r.members.map((p) => (p === old ? pid : p)))];
    if (r.owner === old) r.owner = pid;
  }
  const was = people.get(old);
  if (was) { people.set(pid, Object.assign({}, was, { pid, last: Date.now() })); people.delete(old); }
  roles.delete(old);
  if (mutes.has(old)) { mutes.set(pid, mutes.get(old)); mutes.delete(old); }
}
/* Become owner on this device by typing /claim with the admin-panel secret.
   Wrong guesses lock the address out for half an hour after five. */
router.post('/claim', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  const ip = ipOf(req), f = claimFails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'too many wrong tries - wait a while' });
  /* Or a one-time code from data/reclaim.json (made by scripts/reclaim-link.mjs),
     used up on the first claim and dead after a day. */
  /* The file holds a list, so a link for one person does not cancel another's
     (a single {code} object, from before, still reads). */
  const RF = join(dirname(FILE), 'reclaim.json');
  let codes = [];
  try { const j = JSON.parse(readFileSync(RF, 'utf8')); codes = Array.isArray(j) ? j : [j]; } catch {}
  codes = codes.filter((c) => c && c.code && c.until > Date.now());
  const once = codes.find((c) => sameSecret(b.code, c.code)) || null;
  const onceOk = Boolean(once);
  if (onceOk) writeJson(RF, codes.filter((c) => c !== once));
  if (!onceOk && !sameSecret(b.code, process.env.ADMIN_URL_TOKEN)) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 1800000; }
    claimFails.set(ip, f);
    return res.status(403).json({ error: 'wrong code' });
  }
  claimFails.delete(ip);
  /* A link made for one person (reclaim-link.mjs <name>) gives back that
     person's identity and rank only - never the owner's. */
  if (onceOk && once.pid) {
    const role = roles.get(once.pid) || '';
    if (once.pid !== pid) takeOver(once.pid, pid);
    if (role) roles.set(pid, role);
    persist();
    return res.json({ ok: true, role: role || 'member', name: (people.get(pid) || {}).name || '' });
  }
  /* A claim from a new device takes over the old owner identity (a reset
     browser loses its token for good): its lines, DMs, groups and name. */
  for (const [old, role] of [...roles]) {
    if (role !== 'owner' || old === pid) continue;
    takeOver(old, pid);
  }
  roles.set(pid, 'owner');
  persist();
  res.json({ ok: true, role: 'owner', name: (people.get(pid) || {}).name || '' });
});

/* Give or take a rank. The owner hands out super admin and admin; a super
   admin hands out admin. Nobody changes someone at or above their own rank. */
router.post('/role', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  const target = String(b.pid || '');
  const want = String(b.role || '');
  if (!people.has(target)) return res.status(404).json({ error: 'nobody by that id' });
  if (want && want !== 'admin' && want !== 'superadmin' && want !== 'supreme') return res.status(400).json({ error: 'not a rank' });
  const mine = rankOf(pid);
  if (target === pid) return res.status(400).json({ error: 'you cannot change your own rank' });
  if (mine < RANK.superadmin || rankOf(target) >= mine || (want && RANK[want] >= mine)) return res.status(403).json({ error: 'your rank cannot do that' });
  if (want) roles.set(target, want); else roles.delete(target);
  touchAuthor(target);
  persist();
  logMod(pid, 'role', { name: (people.get(target) || {}).name || target, role: want || 'none' });
  res.json({ ok: true, role: want });
});

/* Name tags are drawn from each message's author, so after a rank changes
   their lines are marked changed and every page redraws them. */
function touchAuthor(pid) {
  for (const r of allRooms()) for (const m of r.messages) if (m.pid === pid) touch(m);
}

/* Mute someone below you for a while (0 lifts it). */
router.post('/mute', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  const target = String(b.pid || '');
  const min = Math.max(0, Math.min(10080, Math.round(Number(b.min) || 0)));
  if (!rankOf(pid) || (rankOf(target) >= rankOf(pid))) return res.status(403).json({ error: 'your rank cannot do that' });
  if (min) mutes.set(target, Date.now() + min * 60000); else mutes.delete(target);
  persist();
  logMod(pid, min ? 'mute' : 'unmute', { name: (people.get(target) || {}).name || target, min });
  res.json({ ok: true, min });
});

/* Ban the device that sent a message (super admin and up). Lifted from the
   admin panel's ban list. */
router.post('/ban', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  if (rankOf(pid) < RANK.superadmin) return res.status(403).json({ error: 'only super admins and the owner can ban' });
  const room = roomOf(req, res, b);
  if (!room) return;
  const m = room.messages.find((x) => x.id === parseInt(b.id, 10));
  if (!m || !m.dev) return res.status(404).json({ error: 'cannot tell who sent that' });
  if (!outranks(pid, m)) return res.status(403).json({ error: 'your rank cannot do that' });
  /* 2026-11-14: only the owner bans outright; anyone else asks the owner. */
  if (rankOf(pid) < RANK.owner && banRequestHook) {
    const r = banRequestHook({ by: pid, pid: m.pid || '', name: m.name, dev: m.dev, text: String(m.text || '').slice(0, 200), reason: String(b.reason || '').slice(0, 120) });
    if (r && r.error) return res.status(409).json({ error: r.error });
    return res.json({ ok: true, pending: true });
  }
  const S = settings();
  if (!S.bannedDevices.includes(m.dev)) setSettings({ bannedDevices: S.bannedDevices.concat([m.dev]) });
  /* Their lines go with them. */
  const gone = room.messages.filter((x) => x.dev === m.dev).map((x) => x.id);
  room.messages = room.messages.filter((x) => x.dev !== m.dev);
  for (const id of gone) noteRemoved(room, id);
  persist();
  logMod(pid, 'ban', { name: m.name, removed: gone.length });
  res.json({ ok: true, removed: gone.length });
});

/* Who is staff, for the tags list. */
router.get('/staff', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ staff: [...roles].map(([pid, role]) => ({ pid, role, name: nameOf(pid) })) });
});

/* People you can message: anyone who chatted here in the last 30 days. */
router.get('/people', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const mine = pidOf(req.query.token);
  const now = Date.now();
  const list = [...people.values()]
    .filter((p) => p.name && now - (p.last || 0) < 30 * 864e5)
    .sort((a, b) => (b.last || 0) - (a.last || 0))
    .slice(0, 400)
    .map((p) => ({ pid: p.pid, name: p.name, color: p.color || '', role: roles.get(p.pid) || '', online: now - (p.last || 0) < 120000, me: p.pid === mine }));
  res.json({ people: list });
});

/* Your DMs and groups, newest activity first. Polled; doubles as "online". */
router.get('/rooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = pidOf(req.query.token);
  if (!pid) return res.json({ rooms: [] });
  if (people.has(pid)) people.get(pid).last = Date.now();
  const list = [...rooms.values()].filter((r) => r.members.includes(pid)).map((r) => roomCard(r, pid));
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const g = general.messages[general.messages.length - 1];
  res.json({ rooms: list, general: g ? g.id : 0 });
});

function newRoomId() { let id; do { id = randomBytes(6).toString('hex'); } while (rooms.has(id)); return id; }
function roomCount(pid) { let n = 0; for (const r of rooms.values()) if (r.members.includes(pid)) n++; return n; }

/* Open (or reopen) the DM between you and one person. */
router.post('/rooms/dm', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  if (!gate(req, res, cleanName(b.name))) return;
  const other = String(b.with || '');
  if (!people.has(other) || other === pid) return res.status(400).json({ error: 'pick someone to message' });
  for (const r of rooms.values()) {
    if (r.kind === 'dm' && r.members.includes(pid) && r.members.includes(other)) return res.json({ ok: true, room: roomCard(r, pid) });
  }
  if (roomCount(pid) >= 150) return res.status(400).json({ error: 'you are in too many chats - leave some first' });
  const r = mkRoom({ id: newRoomId(), kind: 'dm', members: [pid, other], owner: pid, created: new Date().toISOString().slice(0, 19), messages: [] });
  rooms.set(r.id, r);
  persist();
  res.json({ ok: true, room: roomCard(r, pid) });
});

const cleanRoomName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);
function cleanMembers(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String))].filter((p) => people.has(p));
}

/* A group chat with up to 25 people. */
router.post('/rooms/group', express.json({ limit: '8kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  if (!gate(req, res, cleanName(b.name))) return;
  const members = [pid, ...cleanMembers(b.members).filter((p) => p !== pid)].slice(0, MAX_MEMBERS);
  if (members.length < 2) return res.status(400).json({ error: 'add at least one person' });
  if (roomCount(pid) >= 150) return res.status(400).json({ error: 'you are in too many chats - leave some first' });
  const title = censor(cleanRoomName(b.title));
  const r = mkRoom({ id: newRoomId(), kind: 'group', name: title, members, owner: pid, created: new Date().toISOString().slice(0, 19), messages: [] });
  rooms.set(r.id, r);
  sysMessage(r, nameOf(pid) + ' made this group with ' + members.slice(1).map(nameOf).join(', ') + '.');
  res.json({ ok: true, room: roomCard(r, pid) });
});

function myGroup(req, res) {
  const b = req.body || {};
  const r = roomOf(req, res, b);
  if (!r) return null;
  if (r === general || r.kind !== 'group') { res.status(400).json({ error: 'only group chats can do that' }); return null; }
  return r;
}

/* Any member can add people. */
router.post('/rooms/add', express.json({ limit: '8kb' }), (req, res) => {
  const r = myGroup(req, res);
  if (!r) return;
  if (!gate(req, res, cleanName(req.body.name))) return;
  const pid = pidOf(req.body.token);
  const add = cleanMembers(req.body.members).filter((p) => !r.members.includes(p));
  if (!add.length) return res.status(400).json({ error: 'nobody new to add' });
  if (r.members.length + add.length > MAX_MEMBERS) return res.status(400).json({ error: 'a group can have ' + MAX_MEMBERS + ' people' });
  r.members.push(...add);
  sysMessage(r, nameOf(pid) + ' added ' + add.map(nameOf).join(', ') + '.');
  res.json({ ok: true, room: roomCard(r, pid) });
});

/* The group's owner can remove someone. */
router.post('/rooms/kick', express.json({ limit: '2kb' }), (req, res) => {
  const r = myGroup(req, res);
  if (!r) return;
  const pid = pidOf(req.body.token);
  if (r.owner !== pid) return res.status(403).json({ error: 'only the person who made the group can remove people' });
  const who = String(req.body.who || '');
  if (!r.members.includes(who) || who === pid) return res.status(400).json({ error: 'they are not in this group' });
  r.members = r.members.filter((p) => p !== who);
  sysMessage(r, nameOf(pid) + ' removed ' + nameOf(who) + '.');
  res.json({ ok: true, room: roomCard(r, pid) });
});

router.post('/rooms/rename', express.json({ limit: '2kb' }), (req, res) => {
  const r = myGroup(req, res);
  if (!r) return;
  if (!gate(req, res, cleanName(req.body.name))) return;
  const pid = pidOf(req.body.token);
  r.name = censor(cleanRoomName(req.body.title));
  sysMessage(r, nameOf(pid) + (r.name ? ' renamed the group to ' + r.name + '.' : ' cleared the group name.'));
  res.json({ ok: true, room: roomCard(r, pid) });
});

/* Leaving a group; the last one out deletes it. */
router.post('/rooms/leave', express.json({ limit: '2kb' }), (req, res) => {
  const r = myGroup(req, res);
  if (!r) return;
  const pid = pidOf(req.body.token);
  r.members = r.members.filter((p) => p !== pid);
  if (!r.members.length) { rooms.delete(r.id); persist(); return res.json({ ok: true }); }
  if (r.owner === pid) r.owner = r.members[0];
  sysMessage(r, nameOf(pid) + ' left the group.');
  res.json({ ok: true });
});

/* ------------------------------------------------------------ servers */

/* Servers (2026-11-14), Discord-style communities. A server has members,
   ranks (owner > admin > mod > member), bans, timeouts, an invite code and
   channels. Every channel is an ordinary room (kind 'channel', server: id)
   with no member list of its own: roomOf asks the server instead, so
   sending, editing, reactions, polls, GIFs and calls all work unchanged.
   Site staff from superadmin up can moderate any server. */
const SRV_RANK = { member: 0, mod: 1, admin: 2, owner: 3 };
const SRV_MAX_MEMBERS = 500, SRV_MAX_CHANNELS = 30, SRV_MAX_OWNED = 5, SRV_MAX_JOINED = 50;
function srvRank(s, pid) {
  if (!s || !pid) return -1;
  if (s.owner === pid) return 3;
  if (rankOf(pid) >= RANK.superadmin) return 3;
  if (!s.members.includes(pid)) return -1;
  return SRV_RANK[(s.roles || {})[pid]] || 0;
}
function newSrvId() { let id; do { id = 's' + randomBytes(5).toString('hex'); } while (servers.has(id)); return id; }
function newInvite() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c;
  do { c = ''; for (let i = 0; i < 7; i++) c += A[randomBytes(1)[0] % A.length]; } while ([...servers.values()].some((s) => s.invite === c));
  return c;
}
const cleanChanName = (v) => String(v || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
const cleanIcon = (v) => [...String(v || '').trim()].slice(0, 2).join('');
const cleanColour = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '');
/* Banner and icon pictures (2026-11-14): must be a picture already uploaded
   through /upload, so nothing from other sites ends up in a server card. */
const cleanPic = (v) => {
  const m = /^\/chatmedia\/([a-f0-9]{40}\.(png|jpg|gif|webp))$/.exec(String(v || ''));
  return m && existsSync(join(MEDIA_DIR, m[1])) ? m[0] : '';
};
function addChannel(s, name, kind) {
  const r = mkRoom({ id: newRoomId(), kind: 'channel', server: s.id, name, ckind: kind === 'voice' ? 'voice' : 'text', members: [], owner: s.owner, created: new Date().toISOString().slice(0, 19), messages: [] });
  rooms.set(r.id, r);
  s.channels.push(r.id);
  return r;
}
function srvCard(s, pid) {
  const now = Date.now();
  const my = srvRank(s, pid);
  return {
    id: s.id, name: s.name, icon: s.icon || '', color: s.color || '', desc: s.desc || '', public: !!s.public,
    banner: s.banner || '', pic: s.pic || '', ownerName: nameOf(s.owner), created: s.created || '',
    owner: s.owner, myRank: my, invite: s.invite,
    channels: s.channels.map((cid) => rooms.get(cid)).filter(Boolean).map((r) => {
      const last = r.messages[r.messages.length - 1];
      return { id: r.id, name: r.name, kind: r.ckind || 'text', topic: r.topic || '', latest: last ? last.id : 0, call: r.ckind === 'voice' ? callRoster(r.id) : undefined };
    }),
    members: s.members.slice(0, SRV_MAX_MEMBERS).map((p) => {
      const pp = people.get(p) || {};
      const until = (s.mutes || {})[p] || 0;
      return { pid: p, name: pp.name || 'someone', color: pp.color || '', rank: s.owner === p ? 'owner' : ((s.roles || {})[p] || ''), online: now - (pp.last || 0) < 120000, me: p === pid, timeout: until > now ? until : 0 };
    }),
    bans: my >= 1 ? (s.bans || []).map((p) => ({ pid: p, name: nameOf(p) })) : [],
  };
}
function srvSys(s, text) {
  const r = rooms.get(s.channels.find((c) => (rooms.get(c) || {}).ckind !== 'voice') || '');
  if (r) sysMessage(r, text);
}
/* The server a request is about, with the caller's rank in it. */
function srvOf(req, res, need) {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return null;
  const s = servers.get(String(b.sid || ''));
  if (!s) { res.status(404).json({ error: 'that server is gone' }); return null; }
  const rk = srvRank(s, pid);
  if (rk < 0) { res.status(403).json({ error: 'you are not in that server' }); return null; }
  if (rk < need) { res.status(403).json({ error: need >= 3 ? 'only the owner can do that' : need === 2 ? 'only admins can do that' : 'only moderators can do that' }); return null; }
  return { s, pid, rk };
}
/* Acting on someone: they must rank below you. */
function srvTarget(res, ctx, who) {
  who = String(who || '');
  if (!who || who === ctx.pid) { res.status(400).json({ error: 'pick someone else' }); return ''; }
  const theirs = ctx.s.owner === who ? 3 : (SRV_RANK[(ctx.s.roles || {})[who]] || 0);
  if (theirs >= ctx.rk) { res.status(403).json({ error: 'they rank the same as you or higher' }); return ''; }
  return who;
}
const durText = (mins) => (mins >= 1440 ? Math.round(mins / 1440) + (mins >= 2880 ? ' days' : ' day') : mins >= 60 ? Math.round(mins / 60) + 'h' : mins + ' min');

router.get('/servers', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = pidOf(req.query.token);
  if (!pid) return res.json({ servers: [] });
  if (people.has(pid)) people.get(pid).last = Date.now();
  res.json({ servers: [...servers.values()].filter((s) => s.members.includes(pid)).map((s) => srvCard(s, pid)) });
});

/* Public servers anyone can join, busiest first. */
router.get('/servers/discover', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = pidOf(req.query.token);
  const now = Date.now();
  const list = [...servers.values()].filter((s) => s.public && !(s.bans || []).includes(pid)).map((s) => ({
    id: s.id, name: s.name, icon: s.icon || '', color: s.color || '', desc: s.desc || '',
    banner: s.banner || '', pic: s.pic || '', ownerName: nameOf(s.owner), created: s.created || '',
    members: s.members.length, online: s.members.filter((p) => now - ((people.get(p) || {}).last || 0) < 120000).length,
    joined: s.members.includes(pid), public: true,
  })).sort((a, b) => b.online - a.online || b.members - a.members).slice(0, 100);
  res.json({ servers: list });
});

/* A public group's card by id, for share links (#group=<id>). */
router.get('/servers/public/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = servers.get(String(req.params.id || ''));
  if (!s || !s.public) return res.status(404).json({ error: 'that group is private or gone' });
  const now = Date.now();
  res.json({ id: s.id, name: s.name, icon: s.icon || '', color: s.color || '', desc: s.desc || '', banner: s.banner || '', pic: s.pic || '', ownerName: nameOf(s.owner), created: s.created || '', members: s.members.length, online: s.members.filter((p) => now - ((people.get(p) || {}).last || 0) < 120000).length, public: true });
});

/* What an invite code points at, before joining. */
router.get('/servers/invite/:code', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const code = String(req.params.code || '').toLowerCase();
  const s = [...servers.values()].find((x) => x.invite === code);
  if (!s) return res.status(404).json({ error: 'that invite is not valid (it may have been reset)' });
  res.json({ id: s.id, name: s.name, icon: s.icon || '', color: s.color || '', desc: s.desc || '', banner: s.banner || '', pic: s.pic || '', ownerName: nameOf(s.owner), members: s.members.length });
});

router.post('/servers/create', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  if (!gate(req, res, cleanName(b.name))) return;
  const name = censor(cleanRoomName(b.title));
  if (!name) return res.status(400).json({ error: 'give your server a name' });
  const all = [...servers.values()];
  if (all.filter((s) => s.owner === pid).length >= SRV_MAX_OWNED) return res.status(400).json({ error: 'you can own ' + SRV_MAX_OWNED + ' servers' });
  if (all.filter((s) => s.members.includes(pid)).length >= SRV_MAX_JOINED) return res.status(400).json({ error: 'you are in too many servers - leave some first' });
  const s = {
    id: newSrvId(), name, icon: censor(cleanIcon(b.icon)), color: cleanColour(b.color), desc: censor(String(b.desc || '').slice(0, 160)),
    public: b.public === true, banner: cleanPic(b.banner), pic: cleanPic(b.pic), owner: pid, members: [pid], roles: {}, bans: [], mutes: {}, invite: newInvite(), channels: [],
    created: new Date().toISOString().slice(0, 19),
  };
  servers.set(s.id, s);
  addChannel(s, 'general', 'text');
  addChannel(s, 'memes', 'text');
  addChannel(s, 'Lounge', 'voice');
  srvSys(s, nameOf(pid) + ' made ' + name + '. Invite friends with code ' + s.invite + '.');
  logMod(pid, 'server_create', { server: name });
  persist();
  res.json({ ok: true, server: srvCard(s, pid) });
});

/* Join by invite code, or straight in when the server is public. */
router.post('/servers/join', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = me(req, res, b);
  if (!pid) return;
  if (!gate(req, res, cleanName(b.name))) return;
  const code = String(b.code || '').trim().toLowerCase().replace(/^.*[#/=]/, '');
  const s = code ? [...servers.values()].find((x) => x.invite === code) : servers.get(String(b.sid || ''));
  if (!s || (!code && !s.public)) return res.status(404).json({ error: 'that invite is not valid (it may have been reset)' });
  if ((s.bans || []).includes(pid)) return res.status(403).json({ error: 'you are banned from ' + s.name });
  if (s.members.includes(pid)) return res.json({ ok: true, server: srvCard(s, pid) });
  if (s.members.length >= SRV_MAX_MEMBERS) return res.status(400).json({ error: 'that server is full' });
  if ([...servers.values()].filter((x) => x.members.includes(pid)).length >= SRV_MAX_JOINED) return res.status(400).json({ error: 'you are in too many servers - leave some first' });
  s.members.push(pid);
  srvSys(s, nameOf(pid) + ' joined the server. Welcome!');
  persist();
  res.json({ ok: true, server: srvCard(s, pid) });
});

router.post('/servers/leave', express.json({ limit: '2kb' }), (req, res) => {
  const c = srvOf(req, res, 0);
  if (!c) return;
  if (c.s.owner === c.pid) return res.status(400).json({ error: 'you own this server - give it to someone or delete it' });
  c.s.members = c.s.members.filter((p) => p !== c.pid);
  delete c.s.roles[c.pid];
  srvSys(c.s, nameOf(c.pid) + ' left the server.');
  persist();
  res.json({ ok: true });
});

router.post('/servers/edit', express.json({ limit: '4kb' }), (req, res) => {
  const c = srvOf(req, res, 2);
  if (!c) return;
  const b = req.body;
  if (b.title !== undefined) { const n = censor(cleanRoomName(b.title)); if (n) c.s.name = n; }
  if (b.icon !== undefined) c.s.icon = censor(cleanIcon(b.icon));
  if (b.color !== undefined) c.s.color = cleanColour(b.color);
  if (b.desc !== undefined) c.s.desc = censor(String(b.desc || '').slice(0, 160));
  if (b.public !== undefined) c.s.public = b.public === true;
  if (b.banner !== undefined) c.s.banner = cleanPic(b.banner);
  if (b.pic !== undefined) c.s.pic = cleanPic(b.pic);
  if (b.resetInvite === true) c.s.invite = newInvite();
  persist();
  res.json({ ok: true, server: srvCard(c.s, c.pid) });
});

router.post('/servers/delete', express.json({ limit: '2kb' }), (req, res) => {
  const c = srvOf(req, res, 3);
  if (!c) return;
  for (const cid of c.s.channels) rooms.delete(cid);
  servers.delete(c.s.id);
  logMod(c.pid, 'server_delete', { server: c.s.name });
  persist();
  res.json({ ok: true });
});

/* Channels: add, rename, topic, delete, move. Admins and up. */
router.post('/servers/channel', express.json({ limit: '4kb' }), (req, res) => {
  const c = srvOf(req, res, 2);
  if (!c) return;
  const b = req.body, s = c.s;
  const nameFor = (kind, v) => (kind === 'voice' ? censor(cleanRoomName(v)) : cleanChanName(censor(String(v || ''))));
  if (b.action === 'add') {
    if (s.channels.length >= SRV_MAX_CHANNELS) return res.status(400).json({ error: 'a server can have ' + SRV_MAX_CHANNELS + ' channels' });
    const kind = b.kind === 'voice' ? 'voice' : 'text';
    const n = nameFor(kind, b.cname);
    if (!n) return res.status(400).json({ error: 'name the channel' });
    addChannel(s, n, kind);
  } else {
    const r = rooms.get(String(b.cid || ''));
    if (!r || r.server !== s.id) return res.status(404).json({ error: 'that channel is gone' });
    if (b.action === 'rename') {
      const n = nameFor(r.ckind, b.cname);
      if (!n) return res.status(400).json({ error: 'name the channel' });
      r.name = n;
    } else if (b.action === 'topic') {
      r.topic = censor(String(b.topic || '').replace(/\s+/g, ' ').trim().slice(0, 120));
    } else if (b.action === 'delete') {
      const texts = s.channels.filter((x) => (rooms.get(x) || {}).ckind !== 'voice').length;
      if (r.ckind !== 'voice' && texts <= 1) return res.status(400).json({ error: 'a server needs at least one text channel' });
      s.channels = s.channels.filter((x) => x !== r.id);
      rooms.delete(r.id);
    } else if (b.action === 'move') {
      const i = s.channels.indexOf(r.id), j = i + (b.dir === 'up' ? -1 : 1);
      if (j >= 0 && j < s.channels.length) { s.channels[i] = s.channels[j]; s.channels[j] = r.id; }
    } else return res.status(400).json({ error: 'unknown action' });
  }
  persist();
  res.json({ ok: true, server: srvCard(s, c.pid) });
});

/* Ranks: the owner makes admins, admins make mods. Handing over: owner only. */
router.post('/servers/role', express.json({ limit: '2kb' }), (req, res) => {
  const c = srvOf(req, res, 2);
  if (!c) return;
  const b = req.body, s = c.s;
  const who = String(b.who || '');
  if (!s.members.includes(who)) return res.status(400).json({ error: 'they are not in this server' });
  if (b.role === 'owner') {
    if (c.rk < 3 || who === s.owner) return res.status(403).json({ error: 'only the owner can do that' });
    s.roles[s.owner] = 'admin';
    s.owner = who;
    delete s.roles[who];
    srvSys(s, nameOf(c.pid) + ' gave the server to ' + nameOf(who) + '.');
  } else {
    if (!srvTarget(res, c, who)) return;
    const role = b.role === 'admin' || b.role === 'mod' ? b.role : '';
    if ((SRV_RANK[role] || 0) >= c.rk) return res.status(403).json({ error: 'you can only give ranks below your own' });
    if (role) s.roles[who] = role; else delete s.roles[who];
    srvSys(s, nameOf(who) + (role ? ' is now ' + (role === 'admin' ? 'an admin' : 'a moderator') : ' is no longer staff') + '.');
  }
  persist();
  res.json({ ok: true, server: srvCard(s, c.pid) });
});

/* Moderation: kick, ban, unban, timeout. Moderators and up. */
router.post('/servers/mod', express.json({ limit: '2kb' }), (req, res) => {
  const c = srvOf(req, res, 1);
  if (!c) return;
  const b = req.body, s = c.s;
  const act = String(b.action || '');
  if (act === 'unban') {
    s.bans = (s.bans || []).filter((p) => p !== String(b.who || ''));
  } else {
    const who = srvTarget(res, c, b.who);
    if (!who) return;
    const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const why = reason ? ' (' + reason + ')' : '';
    if (act === 'kick' || act === 'ban') {
      s.members = s.members.filter((p) => p !== who);
      delete s.roles[who];
      if (act === 'ban') {
        s.bans = [...new Set([...(s.bans || []), who])];
        if (b.purge === true) {
          for (const cid of s.channels) {
            const r = rooms.get(cid);
            if (!r) continue;
            r.messages = r.messages.filter((m) => {
              const go = m.pid === who && Date.now() - Date.parse(m.date + 'Z') < 3600000;
              if (go) noteRemoved(r, m.id);
              return !go;
            });
          }
        }
      }
      srvSys(s, nameOf(who) + ' was ' + (act === 'ban' ? 'banned' : 'kicked') + ' by ' + nameOf(c.pid) + why + '.');
    } else if (act === 'timeout') {
      const mins = Math.max(0, Math.min(10080, parseInt(b.mins, 10) || 0));
      s.mutes = s.mutes || {};
      if (mins) s.mutes[who] = Date.now() + mins * 60000; else delete s.mutes[who];
      srvSys(s, mins ? nameOf(who) + ' was timed out for ' + durText(mins) + ' by ' + nameOf(c.pid) + why + '.' : 'The timeout on ' + nameOf(who) + ' was lifted.');
    } else return res.status(400).json({ error: 'unknown action' });
  }
  persist();
  res.json({ ok: true, server: srvCard(s, c.pid) });
});

/* ------------------------------------------------------------ GIF search */

/* With a GIPHY key in .env (GIPHY_KEY, free at developers.giphy.com) search
   covers everything. Without one it falls back to nekos.best, which needs no
   key but only has anime reaction GIFs, one set per reaction. */
const gifCache = new Map();
async function cached(key, ms, fn) {
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  gifCache.set(key, { at: Date.now(), v });
  if (gifCache.size > 400) gifCache.delete(gifCache.keys().next().value);
  return v;
}
const viaHere = (url) => {
  const m = /^https:\/\/([a-z0-9.-]+)\/([^?#]+)/i.exec(String(url || ''));
  return m && REMOTE_HOSTS.test(m[1]) ? '/api/chat/gif/' + m[1] + '/' + m[2] : '';
};
async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'XenonChat/1.0 (+https://zpack.beauty)' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('status ' + r.status);
  return r.json();
}

const SYN = {
  lol: 'laugh', lmao: 'laugh', haha: 'laugh', funny: 'laugh', xd: 'laugh', rofl: 'laugh',
  sad: 'cry', crying: 'cry', tears: 'cry', depressed: 'cry',
  hi: 'wave', hello: 'wave', hey: 'wave', bye: 'wave', goodbye: 'wave', yo: 'wave',
  mad: 'angry', rage: 'angry', annoyed: 'angry', grr: 'angry',
  ok: 'thumbsup', okay: 'thumbsup', good: 'thumbsup', nice: 'thumbsup', great: 'thumbsup', yes: 'nod', yeah: 'nod', agree: 'nod',
  no: 'nope', nah: 'nope', never: 'nope',
  love: 'hug', friend: 'hug', hugs: 'hug', kisses: 'kiss',
  wow: 'shocked', omg: 'shocked', what: 'shocked', surprised: 'shocked', shock: 'shocked',
  gg: 'clap', congrats: 'clap', bravo: 'clap', applause: 'clap',
  sleepy: 'sleep', tired: 'yawn', night: 'sleep', gn: 'sleep',
  hmm: 'think', thinking: 'think', idk: 'shrug', whatever: 'shrug', confused: 'confused', huh: 'confused',
  cool: 'smug', proud: 'smug', flex: 'smug',
  party: 'dance', vibe: 'dance', vibing: 'dance', dancing: 'dance',
  food: 'nom', eat: 'nom', eating: 'nom', hungry: 'feed', snack: 'nom',
  fight: 'punch', hit: 'punch', smack: 'slap', attack: 'kick',
  cute: 'blush', shy: 'blush', embarrassed: 'blush', uwu: 'blush',
  bruh: 'facepalm', why: 'facepalm', fail: 'facepalm', cringe: 'facepalm',
  yay: 'happy', excited: 'happy', hype: 'happy', joy: 'happy',
  bored: 'bored', boring: 'bored', run: 'run', running: 'run', bye2: 'run',
  respect: 'salute', sir: 'salute', thanks: 'thumbsup', ty: 'thumbsup',
  flip: 'tableflip', rage2: 'tableflip', bonk: 'bonk', jail: 'bonk', horny: 'bonk',
  stare: 'stare', looking: 'stare', sus: 'stare', tea: 'sip', drink: 'sip', coffee: 'sip',
  hide: 'lurk', lurking: 'lurk', watching: 'lurk',
};
const FEATURED = ['happy', 'laugh', 'wave', 'thumbsup', 'dance', 'cry', 'shocked', 'facepalm', 'hug', 'clap', 'smug', 'think'];

async function nekoCats() {
  return cached('neko:cats', 86400000, async () => {
    const j = await getJson('https://nekos.best/api/v2/endpoints');
    return Object.keys(j).filter((k) => j[k] && j[k].format === 'gif').sort();
  });
}
const nekoItems = (j) => ((j && j.results) || []).map((r) => {
  const u = viaHere(r.url);
  const d = r.dimensions || {};
  return u ? { u, p: u, w: d.width || 0, h: d.height || 0, t: r.anime_name || '' } : null;
}).filter(Boolean);

router.get('/gifs', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = String(req.query.q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  const key = process.env.GIPHY_KEY;
  const klipy = process.env.KLIPY_KEY;
  try {
    /* KLIPY (KLIPY_KEY, free at klipy.com) - the Tenor replacement Discord
       reportedly moved to. GET /api/v1/<key>/gifs/{search,trending}; answers
       {result, data: {data: [items]}}, each item's file holding hd/md/sm/xs
       sizes in gif/webp/mp4. Ads come back as items too (type "ad"). */
    if (klipy) {
      const url = 'https://api.klipy.com/api/v1/' + encodeURIComponent(klipy) + '/gifs/' +
        (q ? 'search?q=' + encodeURIComponent(q) + '&' : 'trending?') +
        'per_page=30&content_filter=medium&customer_id=' + ipHash(clientIp(req)).slice(0, 16);
      const items = await cached('klipy:' + q, 300000, async () => {
        const j = await getJson(url);
        const list = (j && j.data && (j.data.data || j.data)) || [];
        return (Array.isArray(list) ? list : []).filter((d) => d && d.type !== 'ad' && d.file).map((d) => {
          const f = d.file;
          const small = (f.sm && (f.sm.gif || f.sm.webp)) || (f.xs && (f.xs.gif || f.xs.webp)) || {};
          const full = (f.md && f.md.gif) || (f.hd && f.hd.gif) || (f.sm && f.sm.gif) || {};
          const p = viaHere(small.url), u = viaHere(full.url);
          return p && u ? { u, p, w: Number(full.width) || 0, h: Number(full.height) || 0, t: d.title || '' } : null;
        }).filter(Boolean);
      });
      return res.json({ source: 'klipy', results: items, cats: [] });
    }
    if (key) {
      const url = q
        ? 'https://api.giphy.com/v1/gifs/search?api_key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(q) + '&limit=30&rating=pg-13'
        : 'https://api.giphy.com/v1/gifs/trending?api_key=' + encodeURIComponent(key) + '&limit=30&rating=pg-13';
      const items = await cached('giphy:' + q, 300000, async () => {
        const j = await getJson(url);
        return (j.data || []).map((d) => {
          const im = d.images || {};
          const small = im.fixed_width_small || im.fixed_width || {};
          const full = im.downsized_medium || im.downsized || im.original || {};
          const p = viaHere(small.url), u = viaHere(full.url);
          return p && u ? { u, p, w: Number(full.width) || 0, h: Number(full.height) || 0, t: d.title || '' } : null;
        }).filter(Boolean);
      });
      return res.json({ source: 'giphy', results: items, cats: [] });
    }
    const cats = await nekoCats();
    let items;
    if (!q) {
      items = await cached('neko:featured', 600000, async () => {
        const sets = await Promise.all(FEATURED.filter((c) => cats.includes(c)).map((c) => getJson('https://nekos.best/api/v2/' + c + '?amount=3').catch(() => null)));
        return sets.flatMap(nekoItems);
      });
    } else {
      const word = q.replace(/[^a-z ]/g, '').trim();
      const cat = cats.includes(word) ? word : (SYN[word] && cats.includes(SYN[word]) ? SYN[word]
        : cats.find((c) => word && (c.startsWith(word) || word.startsWith(c))) ||
          word.split(' ').map((w) => (cats.includes(w) ? w : SYN[w])).find((c) => c && cats.includes(c)));
      items = await cached('neko:' + (cat || 'q:' + q), 120000, async () => {
        const j = cat
          ? await getJson('https://nekos.best/api/v2/' + cat + '?amount=20')
          : await getJson('https://nekos.best/api/v2/search?query=' + encodeURIComponent(q) + '&type=2&amount=20');
        return nekoItems(j);
      });
    }
    return res.json({ source: 'nekos', results: items, cats });
  } catch (e) {
    return res.status(502).json({ error: 'GIF search is not answering right now', results: [], cats: [] });
  }
});

/* GET /wp-json/wp/v2/comments?post=97&per_page=100&order=asc
   The fields the old chat page read: id, author_name, date (UTC, no zone -
   the page appends the Z), and content.rendered. */
export function commentsFeed(req, res) {
  res.set('Cache-Control', 'no-store');
  if (String(req.query.post || '') !== String(POST_ID)) return res.json([]);
  const per = Math.max(1, Math.min(100, parseInt(req.query.per_page, 10) || 10));
  const asc = String(req.query.order || 'desc').toLowerCase() === 'asc';
  // Always the newest `per` messages, so a long chat shows its latest lines
  // (WordPress would have served the oldest ones for order=asc).
  const page = general.messages.slice(-per);
  const out = page.map((c) => ({
    id: c.id,
    post: POST_ID,
    author_name: c.name,
    date: c.date,
    date_gmt: c.date,
    content: { rendered: '<p>' + escapeHtml(c.text || (c.att ? '[picture]' : '')) + '</p>\n' },
  }));
  return res.json(asc ? out : out.reverse());
}

/* Used only by the admin panel (routes/admin.js). */
/* #general only: private rooms are not the admin panel's to read. */
export const chatAdmin = {
  list(limit = 200) { return general.messages.slice(-limit).map((m) => ({ ...m, owner: undefined })); },
  all() { return general.messages.map((m) => ({ id: m.id, name: m.name, text: m.text, date: m.date, att: m.att })); },
  count() { return general.messages.length; },
  remove(id) {
    const i = general.messages.findIndex((m) => m.id === id);
    if (i === -1) return false;
    general.messages.splice(i, 1); noteRemoved(general, id); persist(); return true;
  },
  purgeName(name) {
    const low = String(name).toLowerCase();
    const gone = general.messages.filter((m) => m.name.toLowerCase() === low).map((m) => m.id);
    general.messages = general.messages.filter((m) => m.name.toLowerCase() !== low);
    gone.forEach((id) => noteRemoved(general, id)); persist(); return gone.length;
  },
  system(text) {
    return sysMessage(general, String(text));
  },
  /* For routes/xenon.js: who a device token is, and a way to speak in
     #general as a named bot (Xenon AI, giveaways, announcements). */
  RANK,
  pidOf,
  rankOf,
  roleOf: (pid) => roles.get(pid) || '',
  nameOf: (pid) => (people.get(pid) || {}).name || '',
  person: (pid) => people.get(pid) || null,
  people: () => [...people.values()],
  staff: () => [...roles].map(([pid, role]) => ({ pid, role, name: (people.get(pid) || {}).name || '' })),
  setRole(pid, role) { if (role) roles.set(pid, role); else roles.delete(pid); touchAuthor(pid); persist(); },
  mute(pid, min) { if (min > 0) mutes.set(pid, Date.now() + min * 60000); else mutes.delete(pid); persist(); },
  touchAuthor(pid) { touchAuthor(pid); persist(); },
  setTagHook(fn) { tagHook = fn; },
  setBanRequestHook(fn) { banRequestHook = fn; },
  /* Ban one device and remove its lines everywhere (owner-approved requests). */
  banDevice(dev) {
    if (!dev) return 0;
    const S = settings();
    if (!S.bannedDevices.includes(dev)) setSettings({ bannedDevices: S.bannedDevices.concat([dev]) });
    let n = 0;
    for (const room of allRooms()) {
      const gone = room.messages.filter((x) => x.dev === dev).map((x) => x.id);
      if (!gone.length) continue;
      room.messages = room.messages.filter((x) => x.dev !== dev);
      for (const id of gone) noteRemoved(room, id);
      n += gone.length;
    }
    persist();
    return n;
  },
  setAuditHook(fn) { auditHook = fn; },
  setMentionHook(fn) { mentionHook = fn; },
  isMuted(pid) { return (mutes.get(pid) || 0) > Date.now(); },
  /* Recent #general lines, oldest first, for the bot's context. */
  recent(n = 14) { return general.messages.slice(-n).map((m) => ({ name: m.name, text: String(m.text || ''), bot: Boolean(m.bot), id: m.id })); },
  find(id) { return general.messages.find((m) => m.id === id) || null; },
  /* Every line this person sent, in every room. */
  purgePid(pid) {
    let n = 0;
    for (const r of allRooms()) {
      const gone = r.messages.filter((m) => m.pid === pid).map((m) => m.id);
      if (!gone.length) continue;
      r.messages = r.messages.filter((m) => m.pid !== pid);
      gone.forEach((id) => noteRemoved(r, id)); n += gone.length;
    }
    persist(); return n;
  },
  /* Ban the devices this person posted from (their messages say which) and
     delete their lines. Returns null when no message shows a device. */
  banPid(pid) {
    const devs = new Set();
    for (const r of allRooms()) for (const m of r.messages) if (m.pid === pid && m.dev) devs.add(m.dev);
    if (devOf.has(pid)) devs.add(devOf.get(pid));
    if (!devs.size) return null;
    const S = settings();
    setSettings({ bannedDevices: [...new Set(S.bannedDevices.concat([...devs]))] });
    return { devices: devs.size, removed: this.purgePid(pid) };
  },
  unbanAll() { const n = settings().bannedDevices.length; setSettings({ bannedDevices: [] }); return n; },
  say(text, opts = {}) {
    const msg = { id: general.nextId++, name: String(opts.name || 'Xenon').slice(0, 24), text: String(text).slice(0, MAX_LEN), date: new Date().toISOString().slice(0, 19), bot: true, color: opts.color || '#c084fc' };
    if (opts.att) msg.att = opts.att;
    if (opts.reply) { const t = general.messages.find((m) => m.id === opts.reply); if (t) msg.reply = { id: t.id, name: t.name, text: snippet(t) }; }
    touch(msg);
    general.messages.push(msg);
    if (general.messages.length > KEEP) general.messages = general.messages.slice(-KEEP);
    persist();
    return msg.id;
  },
  clearGeneral() {
    const gone = general.messages.map((m) => m.id);
    general.messages = [];
    gone.forEach((id) => noteRemoved(general, id));
    persist();
    return gone.length;
  },
};

export default router;
