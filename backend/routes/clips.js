/**
 * Game clips people chose to share.
 *
 * Recording and the rolling buffer happen in the visitor's browser (see
 * public/clip-agent.js); a clip only reaches this PC when someone presses
 * Share. Files live in data/clips/ under a random id, with a small index in
 * data/clips.json. Limits are per person and in total so nobody can fill the
 * disk.
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uidOf, profileByDevice } from './presence.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const CLIP_DIR = join(DATA, 'clips');
const INDEX = join(DATA, 'clips.json');
mkdirSync(CLIP_DIR, { recursive: true });

const CLIP_MAX = 60 * 1024 * 1024;
const PER_PERSON = 40;
const TOTAL_MAX = 8 * 1024 * 1024 * 1024;
const GAP_MS = 8000;

const router = express.Router();
let clips = [];
try { if (existsSync(INDEX)) clips = JSON.parse(readFileSync(INDEX, 'utf8')); } catch { clips = []; }
function save() {
  writeFileSync(INDEX + '.tmp', JSON.stringify(clips));
  renameSync(INDEX + '.tmp', INDEX);
}
const lastUpload = new Map();

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n).trim();
const pub = (c) => ({ id: c.id, uid: c.uid, name: c.name, game: c.game, title: c.title, dur: c.dur, size: c.size, at: c.at, url: '/clipfiles/' + c.file });

export function clipsBy(uid) {
  return clips.filter((c) => c.uid === uid).sort((a, b) => b.at - a.at).map(pub);
}

function isVideo(buf) {
  if (buf.length < 16) return null;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  return null;
}

router.post('/', express.raw({ type: ['video/*', 'application/octet-stream'], limit: CLIP_MAX }), (req, res) => {
  const id = clean(req.query.id, 64);
  if (!id) return res.status(400).json({ ok: false, error: 'no id' });
  const uid = uidOf(id);
  const buf = req.body;
  const ext = Buffer.isBuffer(buf) ? isVideo(buf) : null;
  if (!ext) return res.status(415).json({ ok: false, error: 'not a video' });
  const now = Date.now();
  if (now - (lastUpload.get(uid) || 0) < GAP_MS) return res.status(429).json({ ok: false, error: 'slow down a little' });
  if (clips.filter((c) => c.uid === uid).length >= PER_PERSON) return res.status(409).json({ ok: false, error: 'you have shared ' + PER_PERSON + ' clips - delete one first' });
  if (clips.reduce((a, c) => a + c.size, 0) + buf.length > TOTAL_MAX) return res.status(507).json({ ok: false, error: 'clip storage is full' });
  lastUpload.set(uid, now);

  const cid = randomBytes(6).toString('base64url');
  const file = cid + '.' + ext;
  writeFileSync(join(CLIP_DIR, file), buf);
  const who = profileByDevice(id);
  const c = {
    id: cid, uid, file,
    name: who ? who.name : 'anon',
    game: clean(req.query.game, 60),
    title: clean(req.query.title, 80),
    dur: Math.max(0, Math.min(600, Number(req.query.dur) || 0)),
    size: buf.length,
    at: now,
  };
  clips.push(c);
  save();
  res.json({ ok: true, clip: pub(c) });
});

router.get('/recent', (req, res) => {
  res.json({ clips: clips.slice().sort((a, b) => b.at - a.at).slice(0, 30).map(pub) });
});

router.get('/:cid', (req, res) => {
  const c = clips.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false });
  res.json({ ok: true, clip: pub(c) });
});

router.post('/:cid/delete', express.json(), (req, res) => {
  const id = clean((req.body || {}).id, 64);
  const i = clips.findIndex((x) => x.id === req.params.cid);
  if (i < 0) return res.status(404).json({ ok: false });
  if (!id || clips[i].uid !== uidOf(id)) return res.status(403).json({ ok: false });
  try { unlinkSync(join(CLIP_DIR, clips[i].file)); } catch {}
  clips.splice(i, 1);
  save();
  res.json({ ok: true });
});

/* Used only by the admin panel. */
export const clipsAdmin = {
  list() { return clips.slice().sort((a, b) => b.at - a.at).map(pub); },
  bytes() { return clips.reduce((a, c) => a + (c.size || 0), 0); },
  remove(cid) {
    const i = clips.findIndex((x) => x.id === cid);
    if (i < 0) return false;
    try { unlinkSync(join(CLIP_DIR, clips[i].file)); } catch {}
    clips.splice(i, 1); save(); return true;
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* The page a share link opens. Plain enough to load fast anywhere. */
export function clipPage(req, res) {
  const c = clips.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).type('html').send('<!doctype html><title>Clip not found</title><body style="background:#070b14;color:#eef3ff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">That clip is gone.</body>');
  const title = c.title || (c.game ? c.game + ' clip' : 'Xenon clip');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(c.name)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="Clipped by ${esc(c.name)} on Xenon">
<meta property="og:type" content="video.other">
<meta property="og:video" content="/clipfiles/${esc(c.file)}">
<meta name="theme-color" content="#070b14">
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#070b14;color:#eef3ff;font-family:system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px}
video{width:min(1100px,100%);max-height:78vh;border-radius:14px;background:#000;border:1px solid rgba(150,185,255,.16)}
h1{margin:0;font-size:1.1rem;font-weight:700}
p{margin:0;font-size:.8rem;color:rgba(226,236,255,.55)}
</style></head><body>
<video src="/clipfiles/${esc(c.file)}" controls autoplay playsinline></video>
<h1>${esc(title)}</h1>
<p>Clipped by ${esc(c.name)}${c.game ? ' in ' + esc(c.game) : ''} &middot; ${new Date(c.at).toLocaleDateString('en-US')}</p>
</body></html>`);
}

export default router;
