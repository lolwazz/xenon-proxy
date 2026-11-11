import express from 'express';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';

const router = express.Router();

/* The bookmarklet library in the proxy's Tools panel.
 *
 * Anyone can post one; it runs inside the proxied page only when a visitor
 * presses Run. Same ownership model as chat: no accounts, the client keeps a
 * random token and we store its hash, so only the poster can delete a post.
 * BOOKMARKLET_ADMIN in .env is the owner's key - posts made with it are
 * marked official, and it can delete anything.
 */

const MAX_CODE = 20000;
const MIN_GAP_MS = 20000;           // one post per IP per 20s
const KEEP = 2000;

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bookmarklets.json');

/* Built in, so the library is never empty. Ids start with "x" so they can
   never collide with posted ones, and they cannot be deleted. */
const BUILTIN = [
  { id: 'x1', name: 'Edit Page', desc: 'Type anywhere on the page. Run again to stop.',
    code: "document.designMode=document.designMode==='on'?'off':'on';" },
  { id: 'x2', name: 'Dark Mode', desc: 'Inverts the page colours, keeps images normal.',
    code: "(function(){var s=document.getElementById('xn-dark');if(s){s.remove();return;}var bg=function(e){var c=e&&getComputedStyle(e).backgroundColor;return c&&c!=='transparent'&&c!=='rgba(0, 0, 0, 0)';};s=document.createElement('style');s.id='xn-dark';s.textContent='html{filter:invert(1) hue-rotate(180deg)!important'+(bg(document.documentElement)||bg(document.body)?'':';background:#fff')+'}img,video,picture,canvas,iframe,[style*=background-image]{filter:invert(1) hue-rotate(180deg)!important}';document.head.appendChild(s);})();" },
  { id: 'x3', name: 'Kill Popups', desc: 'Removes overlays, cookie walls and sticky bars, and unlocks scrolling.',
    code: "(function(){var n=0;document.querySelectorAll('body *').forEach(function(e){var c=getComputedStyle(e);if((c.position==='fixed'||c.position==='sticky')&&parseInt(c.zIndex||0,10)>10){e.remove();n++;}});document.documentElement.style.setProperty('overflow','auto','important');document.body.style.setProperty('overflow','auto','important');console.log('removed '+n);})();" },
  { id: 'x4', name: 'Video Speed', desc: 'Sets every video on the page to a speed you choose.',
    code: "(function(){var r=parseFloat(prompt('Playback speed','2'));if(!r)return;document.querySelectorAll('video,audio').forEach(function(v){v.playbackRate=r;});})();" },
  { id: 'x5', name: 'Picture in Picture', desc: 'Pops the biggest video out into its own floating window.',
    code: "(function(){var v=[].slice.call(document.querySelectorAll('video')).sort(function(a,b){return b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight;})[0];if(!v){alert('no video here');return;}v.disablePictureInPicture=false;v.requestPictureInPicture();})();" },
  { id: 'x6', name: 'Show Passwords', desc: 'Turns password boxes into plain text so you can see what you typed.',
    code: "document.querySelectorAll('input[type=password]').forEach(function(i){i.type='text';});" },
  { id: 'x7', name: 'Unblock Copy', desc: 'Re-enables right click, text selection and copy on sites that block them.',
    code: "(function(){['contextmenu','copy','cut','paste','selectstart','mousedown'].forEach(function(t){document.addEventListener(t,function(e){e.stopPropagation();},true);});var s=document.createElement('style');s.textContent='*{user-select:text!important;-webkit-user-select:text!important}';document.head.appendChild(s);})();" },
  { id: 'x8', name: 'Fullscreen', desc: 'Makes the whole page fullscreen.',
    code: "document.documentElement.requestFullscreen();" },
].map((b) => Object.assign({ author: 'Xenon', official: true, builtin: true, date: '2026-10-20T00:00:00', uses: 0 }, b));

let posts = [];
try { posts = JSON.parse(readFileSync(FILE, 'utf8')); } catch { posts = []; }
if (!Array.isArray(posts)) posts = [];
let nextId = posts.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;

/* Run counts for the built-ins, kept beside the posts. */
let builtinUses = {};
try { builtinUses = JSON.parse(readFileSync(FILE.replace(/\.json$/, '-uses.json'), 'utf8')) || {}; } catch { builtinUses = {}; }

let saveTimer = null;
function persist() {
  /* Run counts change often; batch writes instead of one per click. */
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE + '.tmp', JSON.stringify(posts));
      renameSync(FILE + '.tmp', FILE);
      writeFileSync(FILE.replace(/\.json$/, '-uses.json'), JSON.stringify(builtinUses));
    } catch (e) {
      console.warn('[bookmarklets] could not save: ' + e.message);
    }
  }, 1500);
}

const fingerprint = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 24);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();

function isAdmin(key) {
  const want = process.env.BOOKMARKLET_ADMIN || '';
  if (!want || !key) return false;
  const a = Buffer.from(String(key)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* People paste bookmarklets as "javascript:..." links, often URL-encoded.
   Store plain code either way. */
function cleanCode(raw) {
  let c = String(raw || '').trim();
  if (/^javascript:/i.test(c)) {
    c = c.replace(/^javascript:/i, '');
    if (/%[0-9a-f]{2}/i.test(c)) { try { c = decodeURIComponent(c); } catch {} }
  }
  return c.trim();
}

const lastPost = new Map();
const lastUse = new Map();

router.get('/list', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fp = req.query.token ? fingerprint(req.query.token) : '';
  const out = BUILTIN.map((b) => Object.assign({}, b, { uses: builtinUses[b.id] || 0 }))
    .concat(posts.map((p) => {
      const c = Object.assign({}, p);
      c.mine = Boolean(fp && p.owner === fp);
      delete c.owner;
      return c;
    }));
  res.json({ items: out });
});

router.post('/add', express.json({ limit: '64kb' }), (req, res) => {
  const b = req.body || {};
  const admin = isAdmin(b.admin);
  const ip = ipOf(req);
  if (!admin) {
    const now = Date.now();
    if (now - (lastPost.get(ip) || 0) < MIN_GAP_MS) return res.status(429).json({ error: 'wait a few seconds before posting again' });
    lastPost.set(ip, now);
  }
  const name = String(b.name || '').trim().slice(0, 48);
  const desc = String(b.desc || '').trim().slice(0, 240);
  const author = String(b.author || '').trim().slice(0, 24) || 'anon';
  const code = cleanCode(b.code);
  if (!name) return res.status(400).json({ error: 'give it a name' });
  if (!code) return res.status(400).json({ error: 'paste the bookmarklet code' });
  if (code.length > MAX_CODE) return res.status(400).json({ error: 'too long (20k max)' });
  /* Reject code that does not even parse, so the library stays runnable. */
  try { new Function(code); } catch (e) { return res.status(400).json({ error: 'that code has a syntax error: ' + e.message }); }

  const post = { id: nextId++, name, desc, code, author, date: new Date().toISOString().slice(0, 19), uses: 0 };
  if (b.token) post.owner = fingerprint(b.token);
  if (admin) post.official = true;
  posts.push(post);
  if (posts.length > KEEP) posts = posts.slice(-KEEP);
  persist();
  res.json({ ok: true, id: post.id });
});

router.post('/delete', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  const i = posts.findIndex((p) => p.id === id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  const mine = b.token && posts[i].owner && posts[i].owner === fingerprint(b.token);
  if (!mine && !isAdmin(b.admin)) return res.status(403).json({ error: 'not yours to delete' });
  posts.splice(i, 1);
  persist();
  res.json({ ok: true });
});

/* Counts a run. One count per IP per bookmarklet per hour, so the "popular"
   sort cannot be pumped by clicking Run in a loop. */
router.post('/use', express.json({ limit: '1kb' }), (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const key = ipOf(req) + '|' + id;
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < 3600000) return res.json({ ok: true });
  lastUse.set(key, now);
  if (lastUse.size > 20000) { for (const [k, t] of lastUse) { if (now - t > 3600000) lastUse.delete(k); } }
  const b = BUILTIN.find((x) => x.id === id);
  if (b) builtinUses[id] = (builtinUses[id] || 0) + 1;
  else {
    const p = posts.find((x) => String(x.id) === id);
    if (!p) return res.status(404).json({ error: 'not found' });
    p.uses = (p.uses || 0) + 1;
  }
  persist();
  res.json({ ok: true });
});

/* Used only by the admin panel. */
export const bookmarkletsAdmin = {
  list() { return posts.slice().reverse().map((p) => ({ ...p, owner: undefined })); },
  count() { return posts.length; },
  remove(id) { const i = posts.findIndex((p) => p.id === id); if (i === -1) return false; posts.splice(i, 1); persist(); return true; },
  official(id, on) { const p = posts.find((x) => x.id === id); if (!p) return false; if (on) p.official = true; else delete p.official; persist(); return true; },
};

/* Is this admin key right? Lets the Tools panel show "official" controls. */
router.post('/admin', express.json({ limit: '1kb' }), (req, res) => {
  res.json({ ok: isAdmin(req.body && req.body.admin) });
});

export default router;
