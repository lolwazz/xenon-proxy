/* App Store and Extensions (2026-11-14).
 *
 * People publish two kinds of things here:
 *   app  - one HTML file. It runs in a sandboxed iframe with no same-origin
 *          access (srcdoc + sandbox without allow-same-origin), so it can
 *          never read the site's storage, chat token or anything else.
 *   ext  - an extension for the regular site. Community extensions are CSS
 *          only: a script made by a stranger and run on every page would
 *          see everyone's chat token. CSS is cleaned of @import and url()
 *          (except data: pictures), so it cannot load or leak anything.
 * The built-in apps and extensions ship with the site (os-apps.js,
 * ext-lib.js); only their ratings live here, under "official:<id>".
 *
 * Everyone can rate 1-5 stars (one rating per person, changeable) and
 * report; three reports hide an item until staff look. The AI route turns
 * a description into a working app or a CSS extension.
 *
 * Identity is the chat token's pid (same hash as routes/chat.js), so no
 * account is needed. Stored in data/store.json.
 */
import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { askAI, aiEnabled } from './ai.js';

const router = express.Router();
const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.STORE_FILE || join(HERE, '..', 'data', 'store.json');
const APP_MAX = 80 * 1024, EXT_MAX = 24 * 1024;
const pidOf = (token) => (token ? createHash('sha256').update('pid:' + String(token)).digest('hex').slice(0, 16) : '');

let S = { items: [], ratings: {} };
try { S = Object.assign(S, JSON.parse(readFileSync(FILE, 'utf8'))); } catch {}
let timer = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE + '.tmp', JSON.stringify(S));
      renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('[store] could not save: ' + e.message); }
  }, 800);
}

const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const BAD = /\b(n[i1]gg|f[a@]gg?ot|kys|porn|hentai|nsfw)\w*/i;
function cleanCss(css) {
  return String(css || '')
    .replace(/<\/?style[^>]*>/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(/javascript:/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\)/gi, 'none')
    .slice(0, EXT_MAX);
}
const COLOR = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '#6366f1');
const ICON = (v) => [...String(v || '').trim()].slice(0, 2).join('') || '✨';

function stats(id) {
  const r = S.ratings[id] || {};
  const v = Object.values(r);
  return { stars: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : 0, votes: v.length };
}
function card(it, pid, withCode) {
  const c = {
    id: it.id, kind: it.kind, name: it.name, desc: it.desc, icon: it.icon, color: it.color,
    author: it.author, mine: it.pid === pid, ai: !!it.ai, created: it.created, installs: it.installs || 0,
    size: (it.code || '').length, ...stats(it.id), myStars: (S.ratings[it.id] || {})[pid] || 0,
  };
  if (withCode) c.code = it.code;
  return c;
}

const gaps = new Map();
function tooFast(key, ms) {
  const t = gaps.get(key) || 0;
  if (Date.now() - t < ms) return true;
  gaps.set(key, Date.now());
  if (gaps.size > 5000) gaps.delete(gaps.keys().next().value);
  return false;
}

/* Listing: newest first, hidden ones left out. Ratings for the built-in
   items come along so the page can show their stars too. */
router.get('/list', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = pidOf(req.query.token);
  const kind = req.query.kind === 'ext' ? 'ext' : 'app';
  const items = S.items.filter((it) => it.kind === kind && !it.hidden).slice(-300).reverse().map((it) => card(it, pid, false));
  const official = {};
  for (const id of Object.keys(S.ratings)) {
    if (id.startsWith('official:')) official[id.slice(9)] = { ...stats(id), myStars: S.ratings[id][pid] || 0 };
  }
  res.json({ items, official, ai: aiEnabled() });
});

/* One item with its code, for installing. */
router.get('/item/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const it = S.items.find((x) => x.id === req.params.id && !x.hidden);
  if (!it) return res.status(404).json({ error: 'that is gone' });
  if (req.query.install === '1') { it.installs = (it.installs || 0) + 1; persist(); }
  res.json(card(it, pidOf(req.query.token), true));
});

router.post('/publish', express.json({ limit: '120kb' }), (req, res) => {
  const b = req.body || {};
  const pid = pidOf(b.token);
  if (!pid) return res.status(403).json({ error: 'open Chat once first so you have an identity' });
  if (tooFast('pub:' + pid, 20000)) return res.status(429).json({ error: 'wait a moment before publishing again' });
  const mine = S.items.filter((x) => x.pid === pid && Date.now() - Date.parse(x.created) < 864e5).length;
  if (mine >= 15) return res.status(429).json({ error: 'that is enough publishing for today' });
  const kind = b.kind === 'ext' ? 'ext' : 'app';
  const name = clean(b.name, 40), desc = clean(b.desc, 200);
  if (!name) return res.status(400).json({ error: 'give it a name' });
  if (BAD.test(name + ' ' + desc)) return res.status(400).json({ error: 'pick a different name or description' });
  let code = String(b.code || '');
  if (kind === 'ext') code = cleanCss(code);
  if (!code.trim()) return res.status(400).json({ error: kind === 'ext' ? 'the CSS is empty' : 'the app is empty' });
  if (code.length > (kind === 'ext' ? EXT_MAX : APP_MAX)) return res.status(400).json({ error: 'that is too big' });
  const it = {
    id: randomBytes(5).toString('hex'), kind, name, desc, icon: ICON(b.icon), color: COLOR(b.color), code,
    author: clean(b.author, 30) || 'someone', pid, ai: b.ai === true, created: new Date().toISOString(), installs: 0, reports: [],
  };
  S.items.push(it);
  if (S.items.length > 3000) S.items.shift();
  persist();
  res.json({ ok: true, item: card(it, pid, true) });
});

router.post('/delete', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = pidOf(b.token);
  const i = S.items.findIndex((x) => x.id === String(b.id || ''));
  if (i < 0) return res.status(404).json({ error: 'already gone' });
  if (S.items[i].pid !== pid) return res.status(403).json({ error: 'only who made it can delete it' });
  delete S.ratings[S.items[i].id];
  S.items.splice(i, 1);
  persist();
  res.json({ ok: true });
});

router.post('/rate', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = pidOf(b.token);
  if (!pid) return res.status(403).json({ error: 'open Chat once first so you have an identity' });
  const stars = Math.max(1, Math.min(5, parseInt(b.stars, 10) || 0));
  const id = String(b.id || '');
  const ok = /^official:[a-z0-9-]{1,40}$/.test(id) || S.items.some((x) => x.id === id);
  if (!ok) return res.status(404).json({ error: 'that is gone' });
  if (tooFast('rate:' + pid + id, 1500)) return res.status(429).json({ error: 'slow down' });
  S.ratings[id] = S.ratings[id] || {};
  S.ratings[id][pid] = stars;
  persist();
  res.json({ ok: true, ...stats(id), myStars: stars });
});

router.post('/report', express.json({ limit: '2kb' }), (req, res) => {
  const b = req.body || {};
  const pid = pidOf(b.token);
  const it = S.items.find((x) => x.id === String(b.id || ''));
  if (!pid || !it) return res.status(404).json({ error: 'that is gone' });
  it.reports = [...new Set([...(it.reports || []), pid])];
  if (it.reports.length >= 3) it.hidden = true;
  persist();
  res.json({ ok: true });
});

/* Describe it, get it. Apps come back as one self-contained HTML file;
   extensions as CSS for the Xenon site. */
const APP_SYS = 'You write small web apps. Reply with ONE complete HTML document and nothing else: no explanation, no markdown fences. ' +
  'Everything inline (CSS in <style>, JS in <script>); no external files, CDNs, fonts or images from the internet (use emoji, CSS and canvas). ' +
  'It runs in a sandboxed iframe: localStorage may be unavailable, so wrap any storage use in try/catch. ' +
  'Make it look modern and polished: dark background, rounded corners, a clear accent colour, readable sizes, works from 320px wide. ' +
  'Keep it under 60 KB. It must work on first load with no setup.';
const EXT_SYS = 'You write CSS that restyles the Xenon website. Reply with CSS only, no explanation, no markdown fences, no @import, no url() except data: images. ' +
  'Useful selectors: body; .sp-dock (bottom app dock); .sp-dock-item (its buttons); .sp-topright (top-right pills); .sp-pill; .sp-statusbar (bottom bar); ' +
  '.sp-page-title (page headings); .dc-shell (chat window); .dc-row (a chat message); .dc-input (chat box); .xn-card (floating cards); .sp-bg (background layer). ' +
  'Use !important where needed. Keep it under 8 KB.';
function stripFence(t) {
  t = String(t || '').trim();
  const m = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(t);
  return (m ? m[1] : t).trim();
}
router.post('/ai', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const pid = pidOf(b.token);
  if (!pid) return res.status(403).json({ error: 'open Chat once first so you have an identity' });
  if (!aiEnabled()) return res.status(503).json({ error: 'the AI is off right now' });
  if (tooFast('ai:' + pid, 15000)) return res.status(429).json({ error: 'one at a time - try again in a few seconds' });
  const kind = b.kind === 'ext' ? 'ext' : 'app';
  const prompt = clean(b.prompt, 1500);
  if (prompt.length < 4) return res.status(400).json({ error: 'describe what you want' });
  const prev = String(b.previous || '').slice(0, 60000);
  const messages = [{ role: 'system', content: kind === 'ext' ? EXT_SYS : APP_SYS }];
  if (prev) messages.push({ role: 'assistant', content: prev }, { role: 'user', content: 'Change it: ' + prompt + '\nReply with the whole updated ' + (kind === 'ext' ? 'CSS' : 'HTML document') + '.' });
  else messages.push({ role: 'user', content: (kind === 'ext' ? 'Make a Xenon extension: ' : 'Make this app: ') + prompt });
  try {
    let code = stripFence(await askAI(messages, 60000));
    if (kind === 'ext') code = cleanCss(code);
    else if (!/<html|<body|<script|<div/i.test(code)) throw new Error('the AI did not return an app - try describing it differently');
    res.json({ ok: true, code });
  } catch (e) {
    res.status(502).json({ error: e.message || 'the AI could not make that' });
  }
});

export default router;
