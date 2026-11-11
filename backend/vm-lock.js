/**
 * Private machines on the VM page, and end-to-end encryption for them.
 *
 * The Windows VM (win10) is shared with everyone. The owner's real PC (mypc,
 * through TightVNC) is private, and its screen and keyboard are encrypted
 * end to end between the browser and this server.
 *
 * Why end to end: the browser's HTTPS ends at Cloudflare, which forwards the
 * traffic down the tunnel. Plain HTTPS therefore lets Cloudflare (or anyone
 * inside the Cloudflare account) read the screen and every keystroke. With
 * this, the stream is sealed with AES-256-GCM using keys only the browser and
 * this PC hold; Cloudflare carries ciphertext.
 *
 * Keys, all from the owner key in .env (WIN10_VM_KEY) and a random salt
 * (WIN10_VM_SALT):
 *   master  = PBKDF2-SHA256(key, salt, 600,000 rounds)        - slow to guess
 *   auth    = HKDF(master, info "xenon mypc auth v1")          - proves the key
 *   c2s/s2c = HKDF(master, salt sn|cn, info "... c2s/s2c v1")  - per session
 * The key itself never crosses the network. Unlocking answers a one-time
 * challenge with HMAC(auth, nonce); the browser keeps only a non-extractable
 * copy of master (in IndexedDB) for later sessions. Each session starts with
 * a mutual proof, so neither end talks to an impostor, and frames carry a
 * strict counter, so nothing can be dropped, reordered or replayed.
 *
 * Entering the key once on a device also sets a cookie good for 180 days.
 * Changing the key in .env (and restarting the proxy) signs every device out.
 */
import { createHmac, createCipheriv, createDecipheriv, timingSafeEqual, randomBytes, pbkdf2, hkdfSync } from 'node:crypto';

/* The host PC is the owner's alone; the Windows VM is shared. */
export const LOCKED = ['mypc'];
/* Private machines whose stream is end-to-end encrypted. */
export const E2E = ['mypc'];
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const KEY = norm(process.env.WIN10_VM_KEY);
const SALT = Buffer.from(String(process.env.WIN10_VM_SALT || 'xenon-vm-salt-v1'), 'utf8');
const ITER = 600000;
const COOKIE = 'xn_vm_owner';
const MAX_AGE = 60 * 60 * 24 * 180;

/* Derived once at start-up, off the main thread (it takes about half a
   second on purpose). Until it is ready nothing can be unlocked. */
let MASTER = null, AUTH = null;
if (KEY) {
  pbkdf2(KEY, SALT, ITER, 32, 'sha256', (err, bits) => {
    if (err) return;
    MASTER = bits;
    AUTH = Buffer.from(hkdfSync('sha256', MASTER, Buffer.alloc(0), 'xenon mypc auth v1', 32));
  });
}
const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p)))).digest();
function same(a, b) { return a.length === b.length && timingSafeEqual(a, b); }

/* Without a key configured the lock fails closed: a private machine with no
   way in is better than one that is quietly open to everyone. */
function token() {
  return KEY ? createHmac('sha256', KEY).update('xenon-vm-owner').digest('hex') : '';
}

export function isLocked(machine) { return LOCKED.includes(machine); }
export function isE2E(machine) { return E2E.includes(machine); }

export function isOwner(req) {
  const want = token();
  if (!want) return false;
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!found) return false;
  return same(Buffer.from(found.slice(COOKIE.length + 1)), Buffer.from(want));
}

/* Guessing is slowed per address: five wrong answers, then a ten minute wait. */
const fails = new Map();     // ip -> { n, until }
function ipOf(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  if (f.until) fails.delete(ip);
  return 0;
}
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }
  fails.set(ip, f);
  if (fails.size > 5000) fails.clear();
}

function cookieFlags(req) {
  /* Through the tunnel the page is https; on localhost it is plain http,
     where a Secure cookie would never be stored. */
  const https = /https/i.test(String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || ''));
  return https ? '; Secure; SameSite=None' : '; SameSite=Lax';
}

/* One-time challenges for unlocking, good for two minutes each. */
const challenges = new Map();   // nonce b64 -> expiry
function readJson(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(body || '{}'); } catch {} cb(j); });
}

export function mountVmLock(app) {
  app.get('/api/pc/lock', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ locked: LOCKED, e2e: E2E, owner: isOwner(req), configured: Boolean(KEY) });
  });

  app.get('/api/pc/challenge', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [n, exp] of challenges) if (exp < now) challenges.delete(n);
    if (challenges.size > 2000) challenges.clear();
    const nonce = randomBytes(32).toString('base64');
    challenges.set(nonce, now + 120000);
    res.json({ nonce, salt: SALT.toString('base64'), it: ITER });
  });

  app.post('/api/pc/unlock', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = ipOf(req);
    const wait = blocked(ip);
    if (wait) return res.status(429).json({ ok: false, why: 'too many wrong keys - try again in ' + Math.ceil(wait / 60) + ' min' });
    if (!KEY) return res.status(401).json({ ok: false, why: 'no key is set up on the server yet' });
    if (!AUTH) return res.status(503).json({ ok: false, why: 'the server is still starting - try again in a second' });
    readJson(req, (j) => {
      const nonce = String(j.nonce || '');
      const exp = challenges.get(nonce);
      challenges.delete(nonce);
      if (!exp || exp < Date.now()) return res.status(400).json({ ok: false, why: 'that took too long - try again' });
      const want = hmac(AUTH, 'unlock', Buffer.from(nonce, 'base64'));
      const ok = same(Buffer.from(String(j.proof || ''), 'base64'), want);
      if (!ok) { failed(ip); return res.status(401).json({ ok: false, why: 'wrong key' }); }
      fails.delete(ip);
      res.setHeader('Set-Cookie', `${COOKIE}=${token()}; Max-Age=${MAX_AGE}; Path=/; HttpOnly${cookieFlags(req)}`);
      res.json({ ok: true });
    });
  });

  /* "Forget this device". */
  app.post('/api/pc/lockout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly${cookieFlags(req)}`);
    res.json({ ok: true });
  });
}

/* One encrypted screen session (see the top of the file). The bridge calls
   hello() as the socket opens, accept() with the browser's answer, then
   seal() for everything going to the browser and open() for everything
   coming from it. open() returns null for anything forged, altered, dropped,
   reordered or replayed, and the bridge hangs up. */
export function e2eSession() {
  const sn = randomBytes(32);
  let cn = null, kc2s = null, ks2c = null, tx = 0n, rx = 0n;
  const iv = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(n, 4); return b; };
  return {
    ready: () => Boolean(MASTER),
    hello: () => ({ t: 'e2e-hello', v: 1, sn: sn.toString('base64') }),
    accept(msg) {
      if (!MASTER || !msg || msg.t !== 'e2e-auth') return null;
      cn = Buffer.from(String(msg.cn || ''), 'base64');
      if (cn.length !== 32) return null;
      if (!same(Buffer.from(String(msg.proof || ''), 'base64'), hmac(AUTH, 'client', sn, cn))) return null;
      const salt = Buffer.concat([sn, cn]);
      kc2s = Buffer.from(hkdfSync('sha256', MASTER, salt, 'xenon mypc c2s v1', 32));
      ks2c = Buffer.from(hkdfSync('sha256', MASTER, salt, 'xenon mypc s2c v1', 32));
      return { t: 'e2e-ok', proof: hmac(AUTH, 'server', sn, cn).toString('base64') };
    },
    seal(plain) {
      const c = createCipheriv('aes-256-gcm', ks2c, iv(tx));
      const head = Buffer.alloc(8); head.writeBigUInt64BE(tx);
      tx++;
      return Buffer.concat([head, c.update(plain), c.final(), c.getAuthTag()]);
    },
    open(frame) {
      if (!kc2s || frame.length < 24) return null;
      const n = frame.readBigUInt64BE(0);
      if (n !== rx) return null;
      const d = createDecipheriv('aes-256-gcm', kc2s, iv(n));
      d.setAuthTag(frame.subarray(frame.length - 16));
      try {
        const out = Buffer.concat([d.update(frame.subarray(8, frame.length - 16)), d.final()]);
        rx++;
        return out;
      } catch { return null; }
    },
  };
}
