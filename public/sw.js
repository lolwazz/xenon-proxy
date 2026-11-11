/* Combined service worker: Ultraviolet + Scramjet */
/* Each engine loads on its own. One throwing importScripts used to fail the
   whole worker ("ServiceWorker script evaluation failed") - which is what a
   school web filter does when it answers one of these files with its block
   page. Now the other engine still works, and the page can say which broke. */
const V = '?v=2';
let uvOk = false, sjOk = false;
try {
  importScripts('/uv/uv.bundle.js' + V);
  importScripts('/uv/uv.config.js' + V);
  importScripts((self.__uv$config && self.__uv$config.sw) || '/uv/uv.sw.js' + V);
  uvOk = typeof UVServiceWorker === 'function';
} catch (e) { console.warn('[sw] Ultraviolet failed to load', e); }
try {
  importScripts('/scram/scramjet.all.js' + V);
  sjOk = typeof $scramjetLoadWorker === 'function';
} catch (e) { console.warn('[sw] Scramjet failed to load', e); }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

let uv = null;
try { if (uvOk) uv = new UVServiceWorker(); } catch (e) { console.warn('[sw] Ultraviolet would not start', e); }
const uvRoute = (event) => Boolean(uv && uv.route(event));

/* The page asks which engines came up (browser.js). */
self.addEventListener('message', (event) => {
  if (event.data === 'xn-engines' && event.source) event.source.postMessage({ xnEngines: { uv: Boolean(uv), scramjet: sjOk } });
});

// Scramjet is created lazily. Constructing it eagerly opens its IndexedDB and
// holds the connection, which blocks the page-side controller's openIDB() and
// makes ScramjetController.init() hang forever.
let scramjet = null;
function getScramjet() {
  if (!scramjet) {
    const { ScramjetServiceWorker } = $scramjetLoadWorker();
    scramjet = new ScramjetServiceWorker();
  }
  return scramjet;
}

/* Scramjet's JS rewriter is WebAssembly. Proxied pages load it as
   <script src="/scram/scramjet.wasm.wasm">, and Scramjet's worker answers
   that one URL with a script wrapping the binary (self.WASM = base64).
   Before 2026-10-21 this worker only handed Scramjet URLs containing
   "/scramjet/", so the raw binary went out as a "script", failed with
   "Invalid or unexpected token", and every proxied page ran with no rewriter
   at all - the cause of GameDistribution games hanging on a spinner. */
function isScramjet(url) {
  return url.indexOf('/scramjet/') !== -1 || url.indexOf('/scram/scramjet.wasm') !== -1;
}

/* YouTube goes to Invidious (inv.nadeko.net). Only top-level / frame
   navigations are redirected, so a page that merely embeds a YouTube
   player or calls its API is left alone. Same rule as xnYt in browser.js. */
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
    } else if (p.indexOf('/scramjet/') === 0) {
      const real = decodeURIComponent(p.slice('/scramjet/'.length));
      const to = xnYt(real);
      if (to !== real) return Response.redirect(self.location.origin + '/scramjet/' + encodeURIComponent(to), 302);
    }
  } catch (e) {}
  return null;
}

async function handleRequest(event) {
  const url = event.request.url;
  const yt = ytRedirect(event);
  if (yt) return yt;

  if (isScramjet(url)) {
    try {
      const sj = getScramjet();
      await sj.loadConfig();
      if (sj.route(event)) return await sj.fetch(event);
    } catch (e) {
      return new Response('Scramjet error: ' + (e && e.message ? e.message : e), {
        status: 500, headers: { 'content-type': 'text/plain' }
      });
    }
  }

  if (uvRoute(event)) return await uv.fetch(event);
  return await fetch(event.request);
}

/* Only proxy traffic goes through this worker. Everything else must fall
 * through to the network untouched - returning without calling respondWith()
 * is what makes the browser do its own native fetch.
 *
 * This matters for media. Calling respondWith() on an <audio> or <video>
 * range request hands the element a response rebuilt by fetch(), which is not
 * the seekable partial it needs: the element sits at readyState 0 with the
 * network still "loading" and never plays. Same-origin music, and any other
 * ranged asset, stalls for as long as the worker is in the way.
 */
self.addEventListener('fetch', (event) => {
  let mine = false;
  try {
    mine = (sjOk && isScramjet(event.request.url)) || uvRoute(event);
  } catch (e) {
    mine = false;
  }
  if (!mine) return;
  event.respondWith(handleRequest(event));
});
