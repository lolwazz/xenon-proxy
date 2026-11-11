/**
 * Live collaboration for Studio.
 *
 * A room is one shared project. Whoever presses Collab creates it from their
 * project and gets a link with the room's code; anyone with the link joins.
 * Everyone in a room edits the same arrangement at once: tracks, clips, BPM
 * and bars. Microphone recordings are uploaded to the room so the others
 * hear them too.
 *
 * The server holds the project and the order of changes. Every change is an
 * op that sets values on something with an id ("clip X now starts at beat 8",
 * "track Y is muted"). The server checks it, applies it, and sends it to
 * everyone in the room - the sender included - in one order. Each browser
 * applies its own change at once (so dragging feels instant) and then applies
 * every op the server sends, in that order, so all copies end up the same.
 *
 * Rooms are kept in data/studio-rooms/ so a restart doesn't end a session,
 * and are deleted after 14 days with nobody in them. The code is 8 random
 * characters (40 bits): only people given the link can find a room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const DIR = fileURLToPath(new URL('../../data/studio-rooms/', import.meta.url));
fs.mkdirSync(DIR, { recursive: true });
const IDLE_DAYS = 14;
const MAX_MEMBERS = 16;
const MAX_TRACKS = 64;
const MAX_CLIPS = 3000;
const MAX_AUDIO = 8 * 1024 * 1024;        // one recording
const MAX_ROOM_AUDIO = 80 * 1024 * 1024;  // all of a room's recordings
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const COLOURS = ['#7aa2ff', '#ff7ab6', '#7ee0a4', '#ffcf5c', '#b18cff', '#5fd3e6', '#ff9a5c', '#e0e07a'];

const rooms = new Map();    // code -> room
const wss = new WebSocketServer({ noServer: true });

function newCode() {
  let s = '';
  const b = randomBytes(8);
  for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
const validCode = (c) => typeof c === 'string' && /^[a-z0-9]{8}$/.test(c);
const validId = (s) => typeof s === 'string' && /^[a-zA-Z0-9]{4,24}$/.test(s);
const str = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').slice(0, max);
function num(n, lo, hi) { const v = Number(n); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; }

/* Clips point at a sample in the pack (a relative path, which /studio/sample
   keeps inside the pack folder) or at a recording uploaded to this room. */
function cleanPath(p, code) {
  if (typeof p !== 'string' || !p || p.length > 300) return null;
  if (p.startsWith('collab:')) return new RegExp('^collab:' + code + '/[a-z0-9]{16}\\.(webm|ogg|wav)$').test(p) ? p : null;
  if (/^[a-z]+:|^[\\/]|\.\.|[\u0000-\u001f]/i.test(p)) return null;
  return p;
}
function cleanClip(c, code) {
  if (!c || !validId(c.id)) return null;
  const p = cleanPath(c.path, code);
  const start = num(c.start, 0, 4096), offset = num(c.offset, 0, 3600), dur = num(c.dur, 0.01, 3600), full = num(c.full, 0.01, 3600);
  if (!p || start === null || offset === null || dur === null || full === null) return null;
  return { id: c.id, path: p, name: str(c.name, 80), start, offset, dur, full, rec: p.startsWith('collab:') };
}
function cleanTrack(t, code) {
  if (!t || !validId(t.id)) return null;
  const clips = Array.isArray(t.clips) ? t.clips.slice(0, 500).map((c) => cleanClip(c, code)).filter(Boolean) : [];
  return { id: t.id, name: str(t.name, 60) || 'Track', mute: !!t.mute, solo: !!t.solo, vol: num(t.vol, 0, 1) ?? 0.8, clips };
}
function cleanState(s, code) {
  const tracks = Array.isArray(s && s.tracks) ? s.tracks.slice(0, MAX_TRACKS).map((t) => cleanTrack(t, code)).filter(Boolean) : [];
  return { bpm: num(s && s.bpm, 40, 220) ?? 130, bars: num(s && s.bars, 4, 256) ?? 64, tracks };
}
const clipCount = (st) => st.tracks.reduce((n, t) => n + t.clips.length, 0);
function findClip(st, id) {
  for (const t of st.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { t, c }; }
  return null;
}

/* Applies one op to a room's project. Returns the op as everyone should
   apply it (cleaned), or null if it is refused. */
function apply(room, op) {
  const st = room.state;
  if (!op || typeof op.k !== 'string') return null;
  switch (op.k) {
    case 'addTrack': {
      if (st.tracks.length >= MAX_TRACKS) return null;
      const t = cleanTrack(op.track, room.code);
      if (!t || st.tracks.some((x) => x.id === t.id)) return null;
      st.tracks.push(t);
      return { k: 'addTrack', track: t };
    }
    case 'delTrack': {
      if (!validId(op.id)) return null;
      st.tracks = st.tracks.filter((t) => t.id !== op.id);
      return { k: 'delTrack', id: op.id };
    }
    case 'setTrack': {
      const t = st.tracks.find((x) => x.id === op.id);
      if (!t || !op.props) return null;
      const props = {};
      if ('name' in op.props) props.name = str(op.props.name, 60) || t.name;
      if ('mute' in op.props) props.mute = !!op.props.mute;
      if ('solo' in op.props) props.solo = !!op.props.solo;
      if ('vol' in op.props) { const v = num(op.props.vol, 0, 1); if (v !== null) props.vol = v; }
      Object.assign(t, props);
      return { k: 'setTrack', id: t.id, props };
    }
    case 'addClip': {
      const t = st.tracks.find((x) => x.id === op.track);
      if (!t || clipCount(st) >= MAX_CLIPS) return null;
      const c = cleanClip(op.clip, room.code);
      if (!c || findClip(st, c.id)) return null;
      t.clips.push(c);
      return { k: 'addClip', track: t.id, clip: c };
    }
    case 'setClip': {
      const f = findClip(st, op.id);
      if (!f || !op.props) return null;
      const props = {};
      for (const [key, lo, hi] of [['start', 0, 4096], ['offset', 0, 3600], ['dur', 0.01, 3600]]) {
        if (key in op.props) { const v = num(op.props[key], lo, hi); if (v !== null) props[key] = v; }
      }
      Object.assign(f.c, props);
      return { k: 'setClip', id: op.id, props };
    }
    case 'delClip': {
      const f = findClip(st, op.id);
      if (!f) return null;
      f.t.clips = f.t.clips.filter((c) => c.id !== op.id);
      return { k: 'delClip', id: op.id };
    }
    case 'setSong': {
      const props = {};
      const b = num(op.bpm, 40, 220); if (b !== null) props.bpm = b;
      const r = num(op.bars, 4, 256); if (r !== null) props.bars = Math.round(r);
      Object.assign(st, props);
      return { k: 'setSong', ...props };
    }
    case 'clear': {
      st.tracks.forEach((t) => { t.clips = []; });
      return { k: 'clear' };
    }
    default: return null;
  }
}

/* ---------- storage ---------- */
const file = (code) => path.join(DIR, code + '.json');
function load(code) {
  if (rooms.has(code)) return rooms.get(code);
  if (!validCode(code)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file(code), 'utf8'));
    const room = { code, name: str(j.name, 60), state: cleanState(j.state, code), updated: j.updated || Date.now(), clients: new Map(), saveTimer: null };
    rooms.set(code, room);
    return room;
  } catch { return null; }
}
function save(room, now) {
  room.updated = Date.now();
  clearTimeout(room.saveTimer);
  const write = () => {
    const tmp = file(room.code) + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ name: room.name, state: room.state, updated: room.updated }), (err) => {
      if (!err) fs.rename(tmp, file(room.code), () => {});
    });
  };
  if (now) write(); else room.saveTimer = setTimeout(write, 1000);
}
function audioDir(code) { return path.join(DIR, code); }
function audioBytes(code) {
  try { return fs.readdirSync(audioDir(code)).reduce((n, f) => n + fs.statSync(path.join(audioDir(code), f)).size, 0); } catch { return 0; }
}
/* Rooms nobody has opened for IDLE_DAYS go, recordings and all. */
function sweep() {
  const cut = Date.now() - IDLE_DAYS * 86400000;
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^([a-z0-9]{8})\.json$/);
    if (!m) continue;
    const live = rooms.get(m[1]);
    if (live && live.clients.size) continue;
    try {
      if (fs.statSync(path.join(DIR, f)).mtimeMs < cut) {
        fs.rmSync(path.join(DIR, f), { force: true });
        fs.rmSync(audioDir(m[1]), { recursive: true, force: true });
        rooms.delete(m[1]);
      }
    } catch {}
  }
}
sweep();
setInterval(sweep, 6 * 3600000).unref();

/* ---------- HTTP ---------- */
const made = new Map();   // ip -> [timestamps] for room creation
function ipOf(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function readBody(req, max, cb) {
  const parts = [];
  let n = 0, dead = false;
  req.on('data', (c) => { n += c.length; if (n > max) { dead = true; req.destroy(); return; } parts.push(c); });
  req.on('end', () => { if (!dead) cb(Buffer.concat(parts)); });
}

export function mountStudioCollab(app) {
  app.post('/api/studio/rooms', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = ipOf(req);
    const now = Date.now();
    const recent = (made.get(ip) || []).filter((t) => now - t < 3600000);
    if (recent.length >= 20) return res.status(429).json({ ok: false, why: 'too many rooms made - try again later' });
    readBody(req, 400 * 1024, (buf) => {
      let j = {};
      try { j = JSON.parse(buf.toString('utf8') || '{}'); } catch { return res.status(400).json({ ok: false, why: 'bad project' }); }
      let code;
      do { code = newCode(); } while (fs.existsSync(file(code)));
      const room = { code, name: str(j.name, 60) || 'Untitled', state: cleanState(j.state, code), updated: now, clients: new Map(), saveTimer: null };
      rooms.set(code, room);
      save(room, true);
      recent.push(now);
      made.set(ip, recent);
      if (made.size > 5000) made.clear();
      res.json({ ok: true, code, state: room.state });
    });
  });

  /* A recording, uploaded so everyone in the room can play it. */
  app.post('/api/studio/rooms/:code/audio', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const room = load(req.params.code);
    if (!room) return res.status(404).json({ ok: false, why: 'no such room' });
    const type = String(req.headers['content-type'] || '');
    const ext = /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : /webm/.test(type) ? 'webm' : null;
    if (!ext) return res.status(415).json({ ok: false, why: 'not a recording' });
    if (audioBytes(room.code) > MAX_ROOM_AUDIO) return res.status(413).json({ ok: false, why: 'this room is out of recording space' });
    readBody(req, MAX_AUDIO, (buf) => {
      if (!buf.length) return res.status(400).json({ ok: false, why: 'empty recording' });
      fs.mkdirSync(audioDir(room.code), { recursive: true });
      const name = randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFile(path.join(audioDir(room.code), name), buf, (err) => {
        if (err) return res.status(500).json({ ok: false, why: 'could not store it' });
        res.json({ ok: true, path: 'collab:' + room.code + '/' + name });
      });
    });
  });

  app.get('/studio/collab-audio/:code/:name', (req, res) => {
    const { code, name } = req.params;
    if (!validCode(code) || !/^[a-z0-9]{16}\.(webm|ogg|wav)$/.test(name)) return res.status(404).end();
    const f = path.join(audioDir(code), name);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(f);
  });
}

/* ---------- live socket ---------- */
export function isStudioCollab(url) { return /^\/studio-collab(\?|$)/.test(url || ''); }

function members(room) {
  return [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, colour: c.colour }));
}
function send(c, msg) { if (c.ws.readyState === c.ws.OPEN) { try { c.ws.send(JSON.stringify(msg)); } catch {} } }
function broadcast(room, msg) { for (const c of room.clients.values()) send(c, msg); }

export function handleStudioUpgrade(req, socket, head) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  const room = load(String(u.searchParams.get('room') || ''));
  if (!room || room.clients.size >= MAX_MEMBERS) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const used = new Set([...room.clients.values()].map((c) => c.colour));
    const me = {
      id: randomBytes(6).toString('hex'), ws,
      name: str(u.searchParams.get('name'), 30) || 'guest',
      colour: COLOURS.find((x) => !used.has(x)) || COLOURS[room.clients.size % COLOURS.length],
      budget: 60, last: Date.now(),
    };
    room.clients.set(me.id, me);
    send(me, { t: 'hello', you: me.id, room: { code: room.code, name: room.name }, state: room.state, members: members(room) });
    broadcast(room, { t: 'members', members: members(room), joined: me.name });

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const beat = setInterval(() => {
      if (!alive) { try { ws.terminate(); } catch {} return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 25000);

    ws.on('message', (data, isBinary) => {
      if (isBinary || data.length > 64 * 1024) return;
      /* A drag sends a few updates a second; more than 60 a second is not a
         person. */
      const now = Date.now();
      me.budget = Math.min(60, me.budget + (now - me.last) * 0.06);
      me.last = now;
      if (me.budget < 1) return;
      me.budget--;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'op') {
        const done = apply(room, msg.op);
        if (!done) { send(me, { t: 'refused', op: msg.op && msg.op.k }); return; }
        broadcast(room, { t: 'op', op: done, by: me.id });
        save(room);
      } else if (msg.t === 'name') {
        me.name = str(msg.name, 30) || me.name;
        broadcast(room, { t: 'members', members: members(room) });
      } else if (msg.t === 'rename' && typeof msg.name === 'string') {
        room.name = str(msg.name, 60) || room.name;
        broadcast(room, { t: 'room', name: room.name });
        save(room);
      }
    });
    const leave = () => {
      clearInterval(beat);
      if (!room.clients.delete(me.id)) return;
      broadcast(room, { t: 'members', members: members(room), left: me.name });
      if (!room.clients.size) save(room, true);
    };
    ws.on('close', leave);
    ws.on('error', leave);
  });
}
