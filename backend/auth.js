/**
 * Password gate for the proxy itself.
 *
 * The tunnel URL is published on a public WordPress page so visitors can find
 * it, which also means anyone else can. Without this, strangers browse the
 * whole internet through the host's home IP and it is the host who answers for
 * whatever they do.
 *
 * Only the proxying routes are gated. The games, music API and cover-art proxy
 * stay open - they are the owner's own content and carry no such risk.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'xn_auth';
const MAX_AGE = 60 * 60 * 24 * 30;      // 30 days

const PASSWORD = process.env.XENON_PASSWORD || '';
const SECRET = process.env.XENON_SECRET || randomBytes(32).toString('hex');

export const authEnabled = Boolean(PASSWORD);

function token() {
  return createHmac('sha256', SECRET).update(PASSWORD).digest('hex');
}

function hasValidCookie(req) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!found) return false;
  const given = Buffer.from(found.slice(COOKIE.length + 1));
  const want = Buffer.from(token());
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

const LOGIN_PAGE = (msg) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Xenon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;
   background:#05070e;color:#eef3ff;font:14px/1.5 "Leelawadee UI","Segoe UI",system-ui,sans-serif}
 form{display:flex;flex-direction:column;gap:1rem;width:min(320px,86vw);text-align:center}
 h1{font-size:2.2rem;font-weight:300;letter-spacing:.18em;margin:0 0 .4rem}
 p{margin:0;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(216,231,255,.45)}
 input{padding:.7rem 1.1rem;border-radius:999px;border:1px solid rgba(150,185,255,.25);
   background:rgba(8,14,26,.6);color:#eef3ff;font:inherit;outline:0}
 input:focus{border-color:rgba(170,205,255,.6)}
 button{padding:.65rem;border:0;border-radius:999px;font:inherit;font-size:.75rem;
   letter-spacing:.12em;text-transform:uppercase;cursor:pointer;
   background:linear-gradient(180deg,#eaf1ff,#b9cdf0);color:#08101f}
 .err{color:#ff8fa3}
</style></head><body>
<form method="POST" action="/login">
  <h1>xenon</h1>
  <p class="${msg ? 'err' : ''}">${msg || 'enter the password'}</p>
  <input type="password" name="password" autofocus autocomplete="current-password" placeholder="password">
  <button type="submit">Unlock</button>
</form></body></html>`;

export function mountAuth(app) {
  if (!authEnabled) return;

  app.get('/login', (req, res) => res.type('html').send(LOGIN_PAGE('')));

  app.post('/login', (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      const given = decodeURIComponent(
        (body.split('&').find((p) => p.startsWith('password=')) || '').slice(9).replace(/\+/g, ' '),
      );
      const a = Buffer.from(given);
      const b = Buffer.from(PASSWORD);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) return res.status(401).type('html').send(LOGIN_PAGE('wrong password'));
      // SameSite=None so the cookie still travels when the portal frames us.
      res.setHeader('Set-Cookie',
        `${COOKIE}=${token()}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=None`);
      res.redirect(302, req.headers.referer && req.headers.referer.includes('/login') ? '/' : '/');
    });
  });
}

// Paths that actually proxy traffic. Everything else is the owner's own stuff.
const GATED = [/^\/$/, /^\/service\//, /^\/scramjet\//, /^\/bare\//, /^\/wisp\//];

export function needsAuth(pathname) {
  if (!authEnabled) return false;
  return GATED.some((re) => re.test(pathname));
}

export function checkRequest(req, res) {
  const pathname = (req.url || '/').split('?')[0];
  if (!needsAuth(pathname)) return true;
  if (hasValidCookie(req)) return true;
  res.writeHead(302, { Location: '/login' });
  res.end();
  return false;
}

export function checkUpgrade(req, socket) {
  const pathname = (req.url || '/').split('?')[0];
  if (!needsAuth(pathname)) return true;
  if (hasValidCookie(req)) return true;
  socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  return false;
}
