import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { settings, setSettings, clientIp, ipHash } from '../site-settings.js';
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
const UPLOAD_MAX = 8 * 1024 * 1024;
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
/* Chat identities: pid -> {pid, name, color, last}. A pid is a hash of the
   device's private token, so it can be shown to everyone while only that
   device can act as it. */
const people = new Map();
/* Staff: pid -> 'owner' | 'superadmin' | 'admin'. Shown as a tag next to the
   name. Each rank can act on the ranks below it and never on its own. */
const roles = new Map();
const mutes = new Map();             // pid -> muted until (ms)
let tagHook = null;                  // pid -> {label,color,font,fx} | null (set by routes/xenon.js)
try {
  const j = JSON.parse(readFileSync(ROOMS_FILE, 'utf8'));
  for (const r of j.rooms || []) rooms.set(r.id, mkRoom(r));
  for (const p of j.people || []) people.set(p.pid, p);
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
      rooms: [...rooms.values()].map((r) => ({ id: r.id, kind: r.kind, name: r.name, members: r.members, owner: r.owner, created: r.created, messages: r.messages })),
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
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();

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
  if (!pid || !r.members.includes(pid)) { res.status(403).json({ error: 'you are not in that chat' }); return null; }
  return r;
}
function seen(pid, name, color) {
  if (!pid) return;
  const p = people.get(pid) || { pid };
  if (name) p.name = name;
  if (color) p.color = color;
  p.last = Date.now();
  people.set(pid, p);
}
const cleanName = (v) => String(v || '').trim().slice(0, 24);
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
  const ext = sniff(buf);
  if (!ext) return res.status(415).json({ error: 'only PNG, JPEG, GIF or WebP pictures' });
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
  const d = dims(buf, ext) || {};
  res.json({ ok: true, u: '/chatmedia/' + name, k: ext === 'gif' ? 'gif' : 'img', w: d.w || 0, h: d.h || 0 });
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
    if ((m = /^\/chatmedia\/([a-f0-9]{40}\.(png|jpg|gif|webp))$/.exec(u))) {
      if (!existsSync(join(MEDIA_DIR, m[1]))) continue;
      if (m[2] === 'gif') k = 'gif';
    } else if ((m = /^\/api\/chat\/gif\/([a-z0-9.-]+)\/[A-Za-z0-9._~=\/-]+$/i.exec(u))) {
      if (!REMOTE_HOSTS.test(m[1]) || u.includes('..')) continue;
      k = /\.gif$/i.test(u) ? 'gif' : 'img';
    } else continue;
    const o = { u, k };
    const w = clampInt(a.w, 1, 20000), h = clampInt(a.h, 1, 20000);
    if (w && h) { o.w = w; o.h = h; }
    if (a.sp) o.sp = 1;
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

const snippet = (m) => String(m.text || (m.poll ? 'poll: ' + m.poll.q : (m.att && m.att.length ? '[picture]' : ''))).replace(/\s+/g, ' ').slice(0, 140);

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

router.post('/send', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  if (burst('ip:' + ipOf(req), 25, 0) || burst('fp:' + (fpOf(body.token) || ipOf(req)), 5, MIN_GAP_MS)) {
    return res.status(429).json({ error: 'slow down a moment' });
  }
  const room = roomOf(req, res, body);
  if (!room) return;
  const name = cleanName(body.name);
  let text = cleanText(body.text);
  const att = cleanAtt(body.att);
  const poll = cleanPoll(body.poll);
  if (!name) return res.status(400).json({ error: 'no name set' });
  if (!text && !att.length && !poll) return res.status(400).json({ error: 'empty message' });

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
  const taken = staffName(name);
  if (taken && taken !== spid) return res.status(403).json({ error: 'that name belongs to a staff member - pick another in Settings' });
  const msg = { id: room.nextId++, name, text, date: new Date().toISOString().slice(0, 19), dev: g.dev };
  if (token) { msg.owner = fpOf(token); msg.pid = pidOf(token); seen(msg.pid, name, colour); }
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
  if (!own && !(mod && outranks(pidOf(token), m))) { res.status(403).json({ error: 'not yours' }); return null; }
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
  if (!e || e.length > 16 || !EMOJI.test(e) || /[<>&"'\sA-Za-z]/.test(e)) return res.status(400).json({ error: 'not an emoji' });
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
setCallCheck((id, token) => { const r = rooms.get(id); const pid = pidOf(token); return Boolean(r && pid && r.members.includes(pid)); });

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
  const S = settings();
  if (!S.bannedDevices.includes(m.dev)) setSettings({ bannedDevices: S.bannedDevices.concat([m.dev]) });
  /* Their lines go with them. */
  const gone = room.messages.filter((x) => x.dev === m.dev).map((x) => x.id);
  room.messages = room.messages.filter((x) => x.dev !== m.dev);
  for (const id of gone) noteRemoved(room, id);
  persist();
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
  say(text, opts = {}) {
    const msg = { id: general.nextId++, name: String(opts.name || 'Xenon').slice(0, 24), text: String(text).slice(0, MAX_LEN), date: new Date().toISOString().slice(0, 19), bot: true, color: opts.color || '#c084fc' };
    if (opts.att) msg.att = opts.att;
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
