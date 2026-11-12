/**
 * Site-wide features that are not chat itself (mounted at /api/x):
 *
 *   notifications   staff posts, Live TV "now playing", giveaways, events
 *   live TV         one channel staff broadcast a video to
 *   live events     full-screen animations the owner (and Supreme) trigger
 *   game of the day picked from popular.json by date, staff can override
 *   playtime        heartbeats while a game is open -> leaderboard, premium
 *   wall of fame    staff-curated names on the Hall page
 *   premium         earned by referrals (20, counting their referrals too)
 *                   or 10 min in each of 20 games, or granted / won
 *   tags            custom name tags (font, colour, effect, icon) with
 *                   optional permissions, shown on chat lines
 *   themes          published site themes, plus an AI theme maker
 *   bot             Xenon AI answering in #general, AI songs
 *   links           the home page's side window of Xenon addresses
 *
 * Identity is the chat token (localStorage sp-chat-token): pid = hash of it.
 * Ranks come from chat (admin < superadmin < supreme < owner).
 * Everything lives in one JSON file, written atomically and debounced.
 */
import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chatAdmin as C } from './chat.js';
import { askAI } from './ai.js';
import { settings, setSettings } from '../site-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.XENON_FILE || join(HERE, '..', 'data', 'xenon.json');
const AUDIT = join(dirname(FILE), 'xenon-audit.jsonl');
const G = join(HERE, '..', '..', 'public', 'g');
const router = express.Router();

/* ------------------------------------------------------------ storage */
const S = {
  links: { title: 'Xenon links', items: [
    { label: 'zpack.beauty', url: 'https://zpack.beauty' },
    { label: 'app.zpack.beauty', url: 'https://app.zpack.beauty' },
    { label: 'froggy.zpack.beauty', url: 'https://froggy.zpack.beauty' },
    { label: 'xenonsschoollearning.online', url: 'https://xenonsschoollearning.online' },
    { label: 'cdn.xenonsschoollearning.online', url: 'https://cdn.xenonsschoollearning.online' },
  ] },
  /* Premium is built but switched off (2026-11-05): nobody sees it except
     staff, nothing is earned, and no gold tags show, until staff turn it on. */
  premiumOn: false,
  notes: [], nextNote: 1,
  tv: null,
  event: null,
  gotd: null,                 // staff override {date, f, t}
  wall: [],
  play: {},                   // pid -> {ms, g: {file: ms}, n: name}
  premium: {},                // pid -> {until (0 = forever), via, at}
  refs: {},                   // pid -> referrer pid
  giveaway: null,
  tags: {},                   // id -> {label, color, color2, font, fx, icon, perms, by, at}
  tagOf: {},                  // pid -> tag id
  themes: [],
  songs: {},
};
try { Object.assign(S, JSON.parse(readFileSync(FILE, 'utf8'))); } catch {}
let saveT = null;
function save() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE + '.tmp', JSON.stringify(S));
      renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('[xenon] could not save: ' + e.message); }
  }, 800);
}
process.on('exit', () => { if (saveT) { clearTimeout(saveT); try { writeFileSync(FILE, JSON.stringify(S)); } catch {} } });
function audit(pid, action, detail) {
  try { appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), pid, name: C.nameOf(pid), action, detail }) + '\n'); } catch {}
}

/* ------------------------------------------------------------ helpers */
const now = () => Date.now();
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '');
const httpUrl = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
const json = express.json({ limit: '24kb' });
const gaps = new Map();
function tooSoon(key, ms) {
  const t = gaps.get(key) || 0;
  if (now() - t < ms) return true;
  gaps.set(key, now());
  if (gaps.size > 20000) for (const [k, v] of gaps) if (now() - v > 3600e3) gaps.delete(k);
  return false;
}
/* At most n hits per window: lets staff work quickly, stops a script. */
const bursts = new Map();
function burst(key, n, windowMs) {
  const t = now();
  const list = (bursts.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= n) { bursts.set(key, list); return true; }
  list.push(t);
  bursts.set(key, list);
  if (bursts.size > 20000) for (const [k, v] of bursts) if (!v.length || t - v[v.length - 1] > 3600e3) bursts.delete(k);
  return false;
}

/* Permissions. Each rank has a set; a custom tag can add more to whoever
   wears it, and only someone holding "tagperms" can hand those out - never
   a permission they do not have themselves. "beyond" is the owner's alone. */
const ALL = ['notify', 'tv', 'wall', 'giveaway', 'premium', 'tags', 'say', 'gotd', 'clear', 'slow', 'banner', 'mute', 'tagperms', 'events', 'links', 'beyond'];
const BY_RANK = {
  0: [],
  1: ['notify', 'tv', 'wall', 'giveaway', 'premium', 'tags', 'say', 'mute'],
  2: ['notify', 'tv', 'wall', 'giveaway', 'premium', 'tags', 'say', 'mute', 'gotd', 'clear', 'slow', 'banner'],
  3: ALL.filter((p) => p !== 'beyond'),
  4: ALL,
};
function permsOf(pid) {
  const set = new Set(BY_RANK[C.rankOf(pid)] || []);
  const t = S.tags[S.tagOf[pid]];
  if (t && Array.isArray(t.perms)) for (const p of t.perms) if (p !== 'beyond') set.add(p);
  return [...set];
}
const can = (pid, p) => permsOf(pid).includes(p);

function isPremium(pid) {
  const p = S.premium[pid];
  return Boolean(p && (!p.until || p.until > now()));
}
const FONTS = ['', 'pusab', 'fredoka', 'comic', 'mono', 'serif', 'pixel', 'marker', 'gothic'];
const FX = ['', 'glow', 'rainbow', 'pulse', 'shimmer', 'fire', 'ice', 'glitch', 'arcady'];
/* What a chat line shows next to the author's name. */
C.setTagHook((pid) => {
  const t = S.tags[S.tagOf[pid]];
  const prem = S.premiumOn && isPremium(pid);
  if (t) return { label: t.label, color: t.color, color2: t.color2 || '', font: t.font || '', fx: t.fx || '', icon: t.icon || '', prem };
  if (prem) return { label: 'PREMIUM', color: '#f5c542', color2: '#ff8a3d', fx: 'shimmer', icon: '✦', prem: true };
  return null;
});

function who(req, src) {
  const token = String((src && src.token) || req.query.token || '');
  const pid = C.pidOf(token);
  return pid || '';
}
/* A person by pid or by their chat name. */
function target(b) {
  if (b.pid && C.person(String(b.pid))) return String(b.pid);
  const n = str(b.name, 40).toLowerCase().replace(/^@/, '');
  if (!n) return '';
  const p = C.people().find((x) => (x.name || '').toLowerCase() === n);
  return p ? p.pid : '';
}

function note(kind, title, text, url) {
  const n = { id: S.nextNote++, at: now(), kind, title: str(title, 80), text: str(text, 240), url: url ? str(url, 300) : '' };
  S.notes.push(n);
  if (S.notes.length > 60) S.notes = S.notes.slice(-60);
  save();
  return n;
}

/* ------------------------------------------------------------ game of the day */
let catalog = { at: 0, popular: [], covers: {} };
function loadCatalog() {
  if (now() - catalog.at < 600e3) return catalog;
  try {
    const popular = JSON.parse(readFileSync(join(G, 'popular.json'), 'utf8'));
    const covers = JSON.parse(readFileSync(join(G, 'covers.json'), 'utf8'));
    catalog = { at: now(), popular: popular.filter((g) => covers[g.f]), covers };
  } catch { catalog.at = now(); }
  return catalog;
}
function today() { return new Date(now() - 6 * 3600e3).toISOString().slice(0, 10); }   // US Central-ish day
function gameOfDay() {
  const d = today();
  if (S.gotd && S.gotd.date === d) return { date: d, f: S.gotd.f, t: S.gotd.t, cover: loadCatalog().covers[S.gotd.f] || '', pick: 'staff' };
  const list = loadCatalog().popular;
  if (!list.length) return null;
  let h = 2166136261;
  for (const c of d) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const g = list[h % list.length];
  return { date: d, f: g.f, t: g.t, cover: catalog.covers[g.f] || '' };
}

/* ------------------------------------------------------------ premium progress */
const REF_GOAL = 20, GAME_GOAL = 20, GAME_MIN_MS = 10 * 60e3;
const qualified = (pid) => ((S.play[pid] || {}).ms || 0) >= 3 * 60e3;
/* Everyone this person brought in, and everyone they brought in, three
   levels down. Only people who actually used the site (3+ minutes in games)
   count, which keeps a pile of empty incognito tabs from earning premium. */
function refCount(pid) {
  const kids = new Map();
  for (const [p, by] of Object.entries(S.refs)) { if (!kids.has(by)) kids.set(by, []); kids.get(by).push(p); }
  let n = 0;
  const seen = new Set([pid]);
  let level = [pid];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next = [];
    for (const p of level) for (const k of kids.get(p) || []) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (qualified(k)) n++;
      next.push(k);
    }
    level = next;
  }
  return n;
}
const games10 = (pid) => Object.values((S.play[pid] || {}).g || {}).filter((ms) => ms >= GAME_MIN_MS).length;
function progress(pid) {
  const r = Math.min(REF_GOAL, refCount(pid)), g = Math.min(GAME_GOAL, games10(pid));
  if (S.premiumOn && !isPremium(pid) && (r >= REF_GOAL || g >= GAME_GOAL)) {
    S.premium[pid] = { until: 0, via: r >= REF_GOAL ? 'refs' : 'play', at: now() };
    C.touchAuthor(pid);
    save();
  }
  const p = S.premium[pid];
  return { on: S.premiumOn, premium: S.premiumOn && isPremium(pid), until: p ? p.until : null, via: p ? p.via : '', refs: r, refGoal: REF_GOAL, games: g, gameGoal: GAME_GOAL, code: pid.slice(0, 10) };
}

/* ------------------------------------------------------------ giveaways */
function finishGiveaway() {
  const g = S.giveaway;
  if (!g || g.done) return;
  g.done = true;
  const pool = g.entrants.filter((p) => !isPremium(p) || g.days);
  if (!pool.length) {
    C.say('🎉 The giveaway for **' + g.prize + '** ended with no entries.', { name: 'Giveaways', color: '#f472b6' });
    save();
    return;
  }
  const win = pool[Math.floor(Math.random() * pool.length)];
  g.winner = win;
  grantPremium(win, g.days, 'giveaway');
  const name = C.nameOf(win) || 'someone';
  C.say('🎉 **' + name + '** won **' + g.prize + '**! (' + g.entrants.length + ' entered)', { name: 'Giveaways', color: '#f472b6' });
  note('giveaway', name + ' won the giveaway', g.prize, '/chat/');
  save();
}
function grantPremium(pid, days, via) {
  const cur = S.premium[pid];
  if (cur && !cur.until) return;          // already forever
  const base = cur && cur.until > now() ? cur.until : now();
  S.premium[pid] = { until: days ? base + days * 864e5 : 0, via, at: now() };
  C.touchAuthor(pid);
  save();
}
setInterval(() => { if (S.giveaway && !S.giveaway.done && S.giveaway.endsAt <= now()) finishGiveaway(); }, 10e3).unref();

/* ------------------------------------------------------------ live state (polled by every page) */
const stealthFor = new Map();   // pid -> expiry, set by staff 'stealth'
router.get('/live', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = who(req);
  const since = parseInt(req.query.since, 10);
  const notes = Number.isFinite(since) ? S.notes.filter((n) => n.id > since) : S.notes.slice(-12);
  const ev = S.event && S.event.at + S.event.dur > now() ? S.event : null;
  const out = {
    t: now(), premiumOn: S.premiumOn, notes, last: S.nextNote - 1, tv: S.tv, event: ev, gotd: gameOfDay(), links: S.links,
    giveaway: S.giveaway && !S.giveaway.done ? { id: S.giveaway.id, prize: S.giveaway.prize, endsAt: S.giveaway.endsAt, n: S.giveaway.entrants.length, in: Boolean(pid && S.giveaway.entrants.includes(pid)) } : null,
  };
  if (pid) {
    const role = C.roleOf(pid);
    out.me = { role, rank: C.rankOf(pid), perms: permsOf(pid), premium: S.premiumOn && isPremium(pid), tag: S.tagOf[pid] || '' };
    const st = stealthFor.get(pid);
    if (st) { stealthFor.delete(pid); if (st > now()) out.stealth = true; }
  }
  res.json(out);
});

/* ------------------------------------------------------------ playtime */
const beats = new Map();
router.post('/play', json, (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  const f = str(b.f, 160);
  if (!pid || !f || !/^[\w .,'()&!+\-\/]+\.html?$/i.test(f)) return res.status(400).json({ error: 'bad beat' });
  const last = beats.get(pid) || 0;
  const gap = now() - last;
  if (gap < 40e3) return res.json({ ok: true, skipped: true });
  beats.set(pid, now());
  const add = last && gap < 150e3 ? Math.min(gap, 75e3) : 60e3;
  const p = S.play[pid] || (S.play[pid] = { ms: 0, g: {} });
  p.ms += add;
  p.g[f] = (p.g[f] || 0) + add;
  if (Object.keys(p.g).length > 400) {
    const keep = Object.entries(p.g).sort((x, y) => y[1] - x[1]).slice(0, 300);
    p.g = Object.fromEntries(keep);
  }
  p.n = C.nameOf(pid) || p.n || '';
  p.last = now();
  save();
  res.json({ ok: true, progress: progress(pid) });
});

/* ------------------------------------------------------------ referrals + premium */
router.post('/ref', json, (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  const code = str(b.ref, 16).toLowerCase();
  if (!pid || !/^[0-9a-f]{8,16}$/.test(code)) return res.status(400).json({ error: 'bad code' });
  if (S.refs[pid]) return res.json({ ok: true, already: true });
  const by = C.people().map((p) => p.pid).concat(Object.keys(S.play)).find((p) => p.startsWith(code));
  if (!by || by === pid) return res.json({ ok: false });
  /* No loops: you cannot be brought in by someone you brought in. */
  let up = by;
  for (let i = 0; i < 10 && up; i++) { if (up === pid) return res.json({ ok: false }); up = S.refs[up]; }
  S.refs[pid] = by;
  save();
  res.json({ ok: true });
});
router.get('/premium', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = who(req);
  if (!pid) return res.status(403).json({ error: 'no token' });
  if (!S.premiumOn && C.rankOf(pid) < 1 && !permsOf(pid).includes('premium')) return res.status(403).json({ error: 'Xenon Premium is not open yet', off: true });
  res.json(progress(pid));
});
router.post('/giveaway/join', json, (req, res) => {
  const pid = who(req, req.body);
  const g = S.giveaway;
  if (!pid) return res.status(403).json({ error: 'no token' });
  if (!g || g.done) return res.status(404).json({ error: 'no giveaway running' });
  if (!C.nameOf(pid)) return res.status(400).json({ error: 'set a chat name first' });
  if (!g.entrants.includes(pid)) g.entrants.push(pid);
  save();
  res.json({ ok: true, n: g.entrants.length });
});

/* ------------------------------------------------------------ hall (leaderboard, wall, staff) */
router.get('/hall', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  const leaders = Object.entries(S.play)
    .map(([pid, p]) => ({ pid, name: C.nameOf(pid) || p.n || '', ms: p.ms, games: Object.keys(p.g || {}).length, top: Object.entries(p.g || {}).sort((a, b) => b[1] - a[1])[0] }))
    .filter((x) => x.name)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 50)
    .map((x) => ({ name: x.name, ms: x.ms, games: x.games, fav: x.top ? x.top[0] : '', tag: S.tags[S.tagOf[x.pid]] ? S.tags[S.tagOf[x.pid]].label : '', prem: S.premiumOn && isPremium(x.pid), role: C.roleOf(x.pid) }));
  const staff = C.staff().filter((s) => s.name).map((s) => ({ name: s.name, role: s.role, tag: S.tags[S.tagOf[s.pid]] || null }));
  const total = Object.values(S.play).reduce((a, p) => a + (p.ms || 0), 0);
  res.json({ leaders, wall: S.wall, staff, total, players: Object.keys(S.play).length, gotd: gameOfDay() });
});

/* ------------------------------------------------------------ themes */
const THEME_KEYS = ['bg', 'panel', 'panel2', 'border', 'accent', 'accent2', 'text', 'muted', 'glow'];
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const v = {};
  for (const k of THEME_KEYS) { const c = String(t[k] || '').trim(); if (COLOR.test(c)) v[k] = c; }
  if (Object.keys(v).length < 5) return null;
  v.font = FONTS.includes(t.font) ? t.font : '';
  v.radius = Math.max(0, Math.min(28, parseInt(t.radius, 10) || 16));
  v.blur = Math.max(0, Math.min(24, parseInt(t.blur, 10) || 12));
  return v;
}
router.get('/themes', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ themes: S.themes.slice(-120).reverse().map((t) => ({ id: t.id, name: t.name, by: t.by, vars: t.vars, uses: t.uses || 0 })) });
});
router.post('/themes', json, (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  if (!pid || !C.nameOf(pid)) return res.status(403).json({ error: 'set a chat name first' });
  const vars = cleanTheme(b.vars);
  const name = str(b.name, 32);
  if (!vars || !name) return res.status(400).json({ error: 'needs a name and colours' });
  if (tooSoon('theme:' + pid, 30e3)) return res.status(429).json({ error: 'one theme every 30 seconds' });
  const t = { id: randomBytes(5).toString('hex'), name, by: C.nameOf(pid), pid, vars, at: now(), uses: 0 };
  S.themes.push(t);
  if (S.themes.length > 300) S.themes = S.themes.slice(-300);
  save();
  res.json({ ok: true, id: t.id });
});
router.post('/themes/use', json, (req, res) => {
  const t = S.themes.find((x) => x.id === String((req.body || {}).id || ''));
  if (t) { t.uses = (t.uses || 0) + 1; save(); }
  res.json({ ok: true });
});
router.post('/themes/ai', json, async (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  if (!pid) return res.status(403).json({ error: 'no token' });
  if (tooSoon('aitheme:' + pid, 12e3)) return res.status(429).json({ error: 'give it a few seconds' });
  const idea = str(b.prompt, 200);
  if (!idea) return res.status(400).json({ error: 'describe the theme' });
  try {
    const text = await askAI([
      { role: 'system', content: 'You design colour themes for a dark glassy website. Reply with ONLY a JSON object, no prose, no code fence: {"name": short name, "bg": hex page tint, "panel": rgba() glass panel colour with alpha 0.4-0.8, "panel2": rgba() hover panel, "border": rgba() border, "accent": hex, "accent2": hex, "text": hex readable on panel, "muted": rgba() secondary text, "glow": rgba() shadow glow, "font": one of ' + FONTS.filter(Boolean).join('/') + ' or "", "radius": 0-28, "blur": 0-24}. Keep text readable.' },
      { role: 'user', content: 'Theme idea: ' + idea },
    ], 20000);
    const m = text.match(/\{[\s\S]*\}/);
    const raw = m ? JSON.parse(m[0]) : null;
    const vars = cleanTheme(raw);
    if (!vars) return res.status(502).json({ error: 'the AI made a theme I could not read - try again' });
    res.json({ ok: true, name: str(raw.name, 32) || idea.slice(0, 32), vars });
  } catch (e) {
    res.status(502).json({ error: String(e.message || 'the AI did not answer').slice(0, 120) });
  }
});

/* ------------------------------------------------------------ bot: AI in chat, songs */
let botBusy = 0;
router.post('/bot/ask', json, async (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  const name = C.nameOf(pid);
  if (!pid || !name) return res.status(403).json({ error: 'set a chat name first' });
  if (settings().chatLocked && C.rankOf(pid) < 1) return res.status(403).json({ error: 'chat is locked' });
  const q = str(b.prompt, 600);
  if (!q) return res.status(400).json({ error: 'ask it something' });
  if (tooSoon('ask:' + pid, 15e3)) return res.status(429).json({ error: 'one question every 15 seconds' });
  if (botBusy >= 2) return res.status(429).json({ error: 'the bot is answering someone else - try again in a moment' });
  botBusy++;
  try {
    const text = await askAI([
      { role: 'system', content: 'You are Xenon AI, the friendly bot in the public chat room of Xenon, a games site. Answer in at most 120 words, casually, using Discord-style markdown. You are talking to ' + name + ' in front of everyone. Never produce anything sexual, hateful or dangerous. Do not help with cheating on schoolwork or tests; offer to explain instead.' },
      { role: 'user', content: q },
    ], 25000);
    C.say('**@' + name + '** ' + text.slice(0, 1800), { name: 'Xenon AI', color: '#7dd3fc' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || 'no answer').slice(0, 120) });
  } finally { botBusy--; }
});
/* Lead sheet -> [midi, startBeat, beats, voice]. */
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteMidi(tok) {
  const s = String(tok || '').trim().replace('♯', '#').replace('♭', 'b');
  const m = /^([A-Ga-g])(#|b)?(\d)?$/.exec(s);
  if (!m) return null;
  const oct = m[3] === undefined ? 5 : +m[3];
  return Math.max(36, Math.min(96, 12 * (oct + 1) + PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)));
}
const tokens = (v) => (Array.isArray(v) ? v.map(String) : String(v || '').split(/[\s,|]+/)).filter(Boolean);
function chordNotes(name) {
  const m = /^([A-G])(#|b)?(m(?!aj)|min|dim|aug|sus2|sus4)?(maj7|m7|7)?/.exec(String(name || '').trim());
  if (!m) return null;
  const root = PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const q = m[3] || '';
  const third = q === 'm' || q === 'min' || q === 'dim' ? 3 : q === 'sus2' ? 2 : q === 'sus4' ? 5 : 4;
  const fifth = q === 'dim' ? 6 : q === 'aug' ? 8 : 7;
  const ivs = [0, third, fifth];
  if (m[4] === '7' || m[4] === 'm7') ivs.push(10); else if (m[4] === 'maj7') ivs.push(11);
  return { root, ivs };
}
function arrange(raw) {
  const out = [];
  const chords = tokens(raw.chords).map(chordNotes).filter(Boolean).slice(0, 8);
  const mel = tokens(raw.melody).slice(0, 64);
  const drums = (Array.isArray(raw.drums) ? raw.drums.join('') : String(raw.drums || '')).toLowerCase().replace(/[^ksh.]/g, '').slice(0, 32) || 'k.h.s.h.k.h.s.h.';
  const bars = Math.max(chords.length, Math.ceil(mel.length / 8), 4);
  const beats = Math.min(32, bars * 4);
  chords.forEach((c, i) => {
    for (let rep = i * 4; rep < beats; rep += chords.length * 4) {
      for (const iv of c.ivs) out.push([60 + ((c.root + iv) % 12), rep, 4, 2]);
      out.push([36 + c.root, rep, 1.5, 1], [36 + c.root, rep + 2, 1, 1], [43 + c.root > 52 ? 31 + c.root : 43 + c.root, rep + 3, 1, 1]);
    }
  });
  let held = null;
  for (let rep = 0; rep < beats; rep += Math.max(4, mel.length / 2)) {
    mel.forEach((tok, i) => {
      const at = rep + i / 2;
      if (at >= beats) return;
      if (tok === '~' && held) { held[2] += 0.5; return; }
      const n = noteMidi(tok);
      if (n == null) { held = null; return; }
      held = [n, at, 0.5, 0];
      out.push(held);
    });
  }
  for (let at = 0, i = 0; at < beats; at += 0.5, i++) {
    const c = drums[i % drums.length];
    if (c !== '.') out.push([c === 'k' ? 36 : c === 's' ? 38 : 42, at, 0.25, 3]);
  }
  return out.slice(0, 600);
}
/* A short tune the AI writes as numbers; the page plays it with Web Audio.
   notes: [midi, startBeat, beats, voice] - voice 0 lead, 1 bass, 2 pad, 3 drum */
router.post('/bot/song', json, async (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  const name = C.nameOf(pid);
  if (!pid || !name) return res.status(403).json({ error: 'set a chat name first' });
  const idea = str(b.prompt, 200) || 'a happy chiptune';
  if (tooSoon('song:' + pid, 20e3)) return res.status(429).json({ error: 'one song every 20 seconds' });
  try {
    /* The AI writes a lead sheet (chords, a melody line, a drum pattern) -
       a few dozen tokens - and the arrangement is built here. Asking it for
       every note took longer than the timeout. */
    let raw = null, notes = [];
    for (let attempt = 0; attempt < 2 && notes.length < 8; attempt++) {
      const text = await askAI([
        { role: 'system', content: 'You write short catchy loops as a lead sheet. Reply with ONLY JSON, no prose, no code fence: {"title": string, "bpm": 70-170, "chords": 4 or 8 chord names like "Am","F","C","G","Dm7","E" (each lasts one bar of 4 beats), "melody": 32 space-separated tokens (each an eighth note) using note names C4-C6 with # for sharps, "-" for rest, "~" to hold the previous note, "drums": 16 characters (eighth notes over 2 bars, repeated) using k kick, s snare, h hat, . rest}. Keep the melody in the key of the chords and make it hooky.' },
        { role: 'user', content: 'Song idea: ' + idea },
      ], 25000);
      const m = text.match(/\{[\s\S]*\}/);
      try { raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
      notes = raw ? arrange(raw) : [];
    }
    if (notes.length < 8) return res.status(502).json({ error: 'the AI wrote a song I could not play - try again' });
    const id = randomBytes(5).toString('hex');
    const song = { id, title: str(raw.title, 60) || idea.slice(0, 60), bpm: Math.max(60, Math.min(180, Math.round(+raw.bpm) || 110)), notes, by: name, at: now() };
    S.songs[id] = song;
    const ids = Object.keys(S.songs);
    if (ids.length > 150) for (const k of ids.slice(0, ids.length - 150)) delete S.songs[k];
    save();
    if (b.post !== false) C.say('🎵 **' + song.title + '** - a song for ' + name + '\nxenonsong:' + id, { name: 'Xenon AI', color: '#7dd3fc' });
    res.json({ ok: true, song });
  } catch (e) {
    res.status(502).json({ error: String(e.message || 'no answer').slice(0, 120) });
  }
});
router.get('/song/:id', (req, res) => {
  const s = S.songs[String(req.params.id)];
  if (!s) return res.status(404).json({ error: 'gone' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(s);
});

/* ------------------------------------------------------------ service worker reports
   When the proxy's worker fails to start on someone's machine, browser.js
   sends what that machine actually received for each worker file (status,
   type, size, first characters, whether its Chrome could parse it) and its
   browser version. No address or name is stored. Read the file on disk. */
const SWDIAG = join(dirname(FILE), 'swdiag.jsonl');
router.post('/swdiag', express.json({ limit: '24kb' }), (req, res) => {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  if (tooSoon('swdiag:' + ip, 20e3)) return res.json({ ok: true });
  const b = req.body || {};
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 8).map((f) => ({
    f: str(f && f.f, 60), status: Number(f && f.status) || 0, type: str(f && f.type, 60), len: Number(f && f.len) || 0,
    head: str(f && f.head, 100), syntax: str(f && f.syntax, 160), fetchError: str(f && f.fetchError, 160),
  }));
  const row = { at: new Date().toISOString(), err: str(b.err, 300), ua: str(b.ua, 200), mem: Number(b.mem) || 0, host: str(req.headers.host, 60), lite: str(b.lite, 80), files };
  try {
    appendFileSync(SWDIAG, JSON.stringify(row) + '\n');
  } catch {}
  res.json({ ok: true });
});

/* ------------------------------------------------------------ staff */
router.get('/staff/info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pid = who(req);
  const perms = pid ? permsOf(pid) : [];
  if (!perms.length) return res.status(403).json({ error: 'staff only' });
  const people = C.people()
    .filter((p) => p.name)
    .sort((a, b) => (b.last || 0) - (a.last || 0))
    .slice(0, 300)
    .map((p) => ({ pid: p.pid, name: p.name, role: C.roleOf(p.pid), tag: S.tagOf[p.pid] || '', prem: isPremium(p.pid), ms: (S.play[p.pid] || {}).ms || 0, online: now() - (p.last || 0) < 120e3 }));
  res.json({
    me: { pid, role: C.roleOf(pid), rank: C.rankOf(pid), perms, name: C.nameOf(pid) },
    allPerms: ALL, fonts: FONTS, fx: FX,
    people, tags: S.tags, wall: S.wall, links: S.links, tv: S.tv, event: S.event, gotd: gameOfDay(),
    giveaway: S.giveaway, premiumOn: S.premiumOn, notes: S.notes.slice(-20).reverse(), settings: { slowSec: settings().slowSec, chatLocked: settings().chatLocked, announce: settings().announce },
  });
});

const EVENTS = { phyllotaxis: 1, rose: 1, lissajous: 1, harmonograph: 1, waves: 1, aurora: 1, tesseract: 4, singularity: 4 };
const ROLE_RANK = { admin: 1, superadmin: 2, supreme: 3 };

router.post('/staff', json, (req, res) => {
  const b = req.body || {};
  const pid = who(req, b);
  const act = String(b.action || '');
  if (!pid) return res.status(403).json({ error: 'no token' });
  if (burst('staff:' + pid, 10, 10e3)) return res.status(429).json({ error: 'slow down a moment' });
  const need = {
    notify: 'notify', tv: 'tv', tvstop: 'tv', event: 'events', eventstop: 'events', wall_add: 'wall', wall_remove: 'wall',
    gotd: 'gotd', gotd_clear: 'gotd', links: 'links', premium: 'premium', premium_revoke: 'premium',
    giveaway: 'giveaway', giveaway_draw: 'giveaway', giveaway_cancel: 'giveaway', premium_switch: 'premium',
    tag_create: 'tags', tag_delete: 'tags', tag_assign: 'tags', tag_perms: 'tagperms',
    role: 'tagperms', mute: 'mute', stealth: 'mute', say: 'say', clear: 'clear', slow: 'slow', lock: 'slow', banner: 'banner',
  }[act];
  if (!need) return res.status(400).json({ error: 'unknown action' });
  if (!can(pid, need)) return res.status(403).json({ error: 'you do not have the "' + need + '" permission' });
  const me = C.nameOf(pid) || 'staff';
  const mine = C.rankOf(pid);
  /* Premium and premium giveaways wait until premium is switched on. */
  if (!S.premiumOn && (act === 'premium' || act === 'giveaway')) return res.status(409).json({ error: 'Xenon Premium is switched off - turn it on in the Staff panel first' });
  const ok = (extra) => { audit(pid, act, b); save(); res.json(Object.assign({ ok: true }, extra || {})); };
  switch (act) {
    case 'notify': {
      const title = str(b.title, 80);
      if (!title) return res.status(400).json({ error: 'needs a title' });
      return ok({ note: note('notify', title, b.text, httpUrl(b.url) || (String(b.url || '').startsWith('/') ? str(b.url, 200) : '')) });
    }
    case 'tv': {
      const url = httpUrl(b.url);
      if (!url) return res.status(400).json({ error: 'needs a link (YouTube or a video page)' });
      const title = str(b.title, 80) || 'Live on Xenon TV';
      S.tv = { url, title, by: me, at: now() };
      note('tv', '📺 Now on Xenon TV', title, '/tv/');
      return ok({ tv: S.tv });
    }
    case 'tvstop': S.tv = null; return ok();
    case 'event': {
      const kind = String(b.kind || '');
      const tier = EVENTS[kind];
      if (!tier) return res.status(400).json({ error: 'unknown event' });
      if (tier === 4 && !can(pid, 'beyond')) return res.status(403).json({ error: 'that event is the owner\'s alone' });
      const dur = Math.max(5, Math.min(120, parseInt(b.sec, 10) || 30)) * 1000;
      S.event = { id: randomBytes(4).toString('hex'), kind, seed: Math.floor(Math.random() * 1e9), at: now() + 1500, dur, by: me, text: str(b.text, 80), hue: Math.max(0, Math.min(360, parseInt(b.hue, 10) || 0)) };
      note('event', '✨ Live event: ' + kind, S.event.text || 'started by ' + me, '');
      return ok({ event: S.event });
    }
    case 'eventstop': S.event = null; return ok();
    case 'wall_add': {
      const name = str(b.name, 32), why = str(b.why, 120);
      if (!name) return res.status(400).json({ error: 'needs a name' });
      S.wall.unshift({ name, why, by: me, at: now(), color: hex(b.color) || '' });
      S.wall = S.wall.slice(0, 60);
      return ok();
    }
    case 'wall_remove': { const i = parseInt(b.i, 10); if (S.wall[i]) S.wall.splice(i, 1); return ok(); }
    case 'gotd': {
      const f = str(b.f, 160);
      if (!/\.html?$/i.test(f)) return res.status(400).json({ error: 'needs a game file' });
      S.gotd = { date: today(), f, t: str(b.t, 80) || f };
      note('gotd', '🎮 Game of the day', S.gotd.t, '/ugs/#play=' + encodeURIComponent(f));
      return ok();
    }
    case 'gotd_clear': S.gotd = null; return ok();
    case 'links': {
      const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ label: str(x && x.label, 40), url: httpUrl(x && x.url) })).filter((x) => x.label && x.url).slice(0, 12);
      S.links = { title: str(b.title, 40) || S.links.title, items: items.length ? items : S.links.items };
      return ok({ links: S.links });
    }
    case 'premium': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      const days = Math.max(0, Math.min(3650, parseInt(b.days, 10) || 0));
      /* Admins hand out up to a month; super admins and up, forever. */
      if (mine < 2 && (!days || days > 31)) return res.status(403).json({ error: 'admins can give up to 31 days' });
      grantPremium(t, days, 'grant:' + me);
      C.say('✦ **' + (C.nameOf(t) || 'someone') + '** got **Xenon Premium**' + (days ? ' for ' + days + ' days' : ' forever') + ' from ' + me + '!', { name: 'Xenon', color: '#f5c542' });
      return ok();
    }
    case 'premium_switch': {
      S.premiumOn = Boolean(b.on);
      for (const pid2 of Object.keys(S.premium)) C.touchAuthor(pid2);
      return ok({ premiumOn: S.premiumOn });
    }
    case 'premium_revoke': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      delete S.premium[t]; C.touchAuthor(t);
      return ok();
    }
    case 'giveaway': {
      if (S.giveaway && !S.giveaway.done) return res.status(409).json({ error: 'a giveaway is already running' });
      const days = Math.max(0, Math.min(365, parseInt(b.days, 10) || 7));
      if (mine < 2 && (!days || days > 31)) return res.status(403).json({ error: 'admins can give away up to 31 days' });
      const mins = Math.max(1, Math.min(1440, parseInt(b.mins, 10) || 5));
      const prize = 'Xenon Premium' + (days ? ' (' + days + ' days)' : ' (forever)');
      S.giveaway = { id: randomBytes(4).toString('hex'), prize, days, endsAt: now() + mins * 60e3, entrants: [], by: me, done: false };
      C.say('🎉 **GIVEAWAY** from ' + me + ': **' + prize + '**! Type `/enter` or press Join in your notifications. Ends in ' + mins + ' min.', { name: 'Giveaways', color: '#f472b6' });
      note('giveaway', '🎉 Giveaway: ' + prize, 'Ends in ' + mins + ' min - press Join', '/chat/');
      return ok({ giveaway: S.giveaway });
    }
    case 'giveaway_draw': finishGiveaway(); return ok({ giveaway: S.giveaway });
    case 'giveaway_cancel': if (S.giveaway) S.giveaway.done = true; return ok();
    case 'tag_create': {
      const label = str(b.label, 18);
      if (!label) return res.status(400).json({ error: 'needs a label' });
      if (Object.keys(S.tags).length >= 200) return res.status(409).json({ error: 'too many tags - delete some' });
      const id = randomBytes(4).toString('hex');
      S.tags[id] = { label, color: hex(b.color) || '#7c5cff', color2: hex(b.color2) || '', font: FONTS.includes(b.font) ? b.font : '', fx: FX.includes(b.fx) ? b.fx : '', icon: str(b.icon, 4), perms: [], by: me, at: now() };
      if (b.fx === 'arcady' && mine < 3) S.tags[id].fx = '';      // Typical's own look
      return ok({ id, tag: S.tags[id] });
    }
    case 'tag_delete': {
      const id = String(b.id || '');
      const t = S.tags[id];
      if (!t) return res.status(404).json({ error: 'no such tag' });
      if (t.perms.length && !can(pid, 'tagperms')) return res.status(403).json({ error: 'that tag carries permissions' });
      delete S.tags[id];
      for (const [p, v] of Object.entries(S.tagOf)) if (v === id) { delete S.tagOf[p]; C.touchAuthor(p); }
      return ok();
    }
    case 'tag_assign': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      const id = String(b.id || '');
      if (id && !S.tags[id]) return res.status(404).json({ error: 'no such tag' });
      if (C.rankOf(t) >= mine && t !== pid && mine < 4) return res.status(403).json({ error: 'you cannot retag someone at or above your rank' });
      if (id && S.tags[id].perms.length && !can(pid, 'tagperms')) return res.status(403).json({ error: 'only someone with "tagperms" can hand out a tag that carries permissions' });
      if (id) S.tagOf[t] = id; else delete S.tagOf[t];
      C.touchAuthor(t);
      return ok();
    }
    case 'tag_perms': {
      const t = S.tags[String(b.id || '')];
      if (!t) return res.status(404).json({ error: 'no such tag' });
      const mineP = permsOf(pid);
      t.perms = (Array.isArray(b.perms) ? b.perms : []).map(String).filter((p) => ALL.includes(p) && p !== 'beyond' && mineP.includes(p));
      for (const [p, v] of Object.entries(S.tagOf)) if (v === b.id) C.touchAuthor(p);
      return ok({ tag: t });
    }
    case 'role': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      if (t === pid) return res.status(400).json({ error: 'not your own rank' });
      const want = String(b.role || '');
      if (want && !ROLE_RANK[want]) return res.status(400).json({ error: 'not a rank' });
      if (C.rankOf(t) >= mine || (want && ROLE_RANK[want] >= mine)) return res.status(403).json({ error: 'your rank cannot do that' });
      C.setRole(t, want);
      if (want) C.say('🛡️ **' + C.nameOf(t) + '** is now ' + { admin: 'an Admin', superadmin: 'a Super Admin', supreme: 'SUPREME' }[want] + '.', { name: 'Xenon', color: '#c084fc' });
      return ok();
    }
    /* Staff stealth (2026-11-12): the person's page picks this up on its next
       /live poll (every 30 s) and switches to stealth on their next click -
       browsers only open the about:blank tab from a click. Kept in memory
       for 10 minutes; a restart forgets it. */
    case 'stealth': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      if (t !== pid && C.rankOf(t) >= mine) return res.status(403).json({ error: 'your rank cannot do that' });
      stealthFor.set(t, now() + 10 * 60e3);
      return ok();
    }
    case 'mute': {
      const t = target(b);
      if (!t) return res.status(404).json({ error: 'nobody by that name' });
      if (C.rankOf(t) >= mine) return res.status(403).json({ error: 'your rank cannot do that' });
      C.mute(t, Math.max(0, Math.min(10080, parseInt(b.min, 10) || 0)));
      return ok();
    }
    case 'say': {
      const text = str(b.text, 600);
      if (!text) return res.status(400).json({ error: 'say what?' });
      C.say(text, { name: 'Xenon', color: '#c084fc' });
      return ok();
    }
    case 'clear': return ok({ removed: C.clearGeneral() });
    case 'slow': setSettings({ slowSec: Math.max(0, Math.min(300, parseInt(b.sec, 10) || 0)) }); return ok();
    case 'lock': setSettings({ chatLocked: Boolean(b.on) }); return ok();
    case 'banner': {
      const level = ['info', 'warn', 'party'].includes(b.level) ? b.level : 'info';
      setSettings({ announce: { text: str(b.text, 200), level } });
      return ok();
    }
  }
  res.status(400).json({ error: 'unknown action' });
});

export default router;
