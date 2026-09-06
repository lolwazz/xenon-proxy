/* Combined service worker: Ultraviolet + Scramjet */
importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts(__uv$config.sw || '/uv/uv.sw.js');
importScripts('/scram/scramjet.all.js');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const uv = new UVServiceWorker();

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

async function handleRequest(event) {
  const url = event.request.url;

  if (url.indexOf('/scramjet/') !== -1) {
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

  if (uv.route(event)) return await uv.fetch(event);
  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
