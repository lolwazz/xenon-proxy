/* Fallback service worker: Ultraviolet only.
 *
 * browser.js registers this when /sw.js fails to start ("ServiceWorker script
 * evaluation failed"), which school Chromebooks reported on 2026-11-05 while
 * the same worker started fine everywhere we could test. This one evaluates
 * about a third less code and leaves Scramjet out entirely, so it has the best
 * chance of starting on an old or memory-starved Chromebook. Pages that ask
 * for Scramjet run under Ultraviolet while this worker is in charge.
 */
const V = '?v=2';
let uv = null;
try {
  importScripts('/uv/uv.bundle.js' + V);
  importScripts('/uv/uv.config.js' + V);
  importScripts((self.__uv$config && self.__uv$config.sw) || '/uv/uv.sw.js' + V);
  uv = new UVServiceWorker();
} catch (e) {
  console.warn('[sw-lite] Ultraviolet failed to load', e);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data === 'xn-engines' && event.source) event.source.postMessage({ xnEngines: { uv: Boolean(uv), scramjet: false, lite: true } });
});

/* Same rule as sw.js: only proxy traffic is answered here, everything else
   goes to the network untouched (ranged audio/video needs that). */
self.addEventListener('fetch', (event) => {
  let mine = false;
  try { mine = Boolean(uv && uv.route(event)); } catch (e) { mine = false; }
  if (!mine) return;
  event.respondWith(ytRedirect(event) || uv.fetch(event));
});

/* YouTube goes to Invidious (inv.nadeko.net); same as in sw.js. */
function xnYt(u) {
  try {
    const w = new URL(u), h = w.hostname.toLowerCase().replace(/^www\./, ''), q = w.search;
    if (h === 'youtu.be') return 'https://inv.nadeko.net/watch?v=' + w.pathname.split('/')[1] + (q ? '&' + q.slice(1) : '');
    if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
      const m = /^\/(shorts|embed|live|v)\/([\w-]{6,})/.exec(w.pathname);
      if (m) return 'https://inv.nadeko.net/watch?v=' + m[2] + (q ? '&' + q.slice(1) : '');
      return 'https://inv.nadeko.net' + w.pathname + q + w.hash;
    }
  } catch (e) {}
  return u;
}
function ytRedirect(event) {
  const r = event.request;
  if (r.mode !== 'navigate' && r.destination !== 'iframe' && r.destination !== 'document') return null;
  try {
    const p = new URL(r.url).pathname;
    const uvp = self.__uv$config && self.__uv$config.prefix;
    if (uvp && p.indexOf(uvp) === 0) {
      const real = self.__uv$config.decodeUrl(p.slice(uvp.length));
      const to = xnYt(real);
      if (to !== real) return Response.redirect(self.location.origin + uvp + self.__uv$config.encodeUrl(to), 302);
    }
  } catch (e) {}
  return null;
}
