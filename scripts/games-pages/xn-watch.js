/* Xenon "watch me play" (2026-11-07). Added to every game page by
 * build-games-pages.mjs.
 *
 * It does nothing until the Xenon page around the game says someone is
 * watching. Then it copies the game's own picture (its biggest <canvas>) into
 * small JPEGs, a few a second, and hands them to that page, which passes them
 * to the people watching. Only the game: never the page around it, other
 * tabs or the screen. It stops the moment the last viewer leaves.
 *
 * A game that draws with HTML instead of a canvas, or one whose canvas the
 * browser won't let us read, says "nope" and the viewer is told so. */
(function () {
  'use strict';
  if (window.__xnWatch || window.parent === window) return;
  window.__xnWatch = 1;
  var parentOrigin = '*';
  var FPS = 4, MAXW = 640, Q = 0.6;
  var timer = 0, retry = 0, tries = 0, recheck = 0;
  var canvas = null, stream = null, vid = null, out = null, octx = null, busy = false;

  function say(msg, transfer) {
    try { window.parent.postMessage(msg, parentOrigin, transfer || []); } catch (e) { /* page gone */ }
  }

  /* Every canvas in this page, in same-origin frames inside it, and in open
     shadow roots (Ruffle draws Flash games inside one). */
  function canvases(doc, list, depth) {
    if (depth > 3) return list;
    try {
      var cs = doc.querySelectorAll('canvas');
      for (var i = 0; i < cs.length; i++) list.push(cs[i]);
      var all = doc.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (el.shadowRoot) canvases(el.shadowRoot, list, depth + 1);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try { if (el.contentDocument) canvases(el.contentDocument, list, depth + 1); } catch (e) { /* other origin */ }
        }
      }
    } catch (e) { /* half-loaded document */ }
    return list;
  }
  function biggest() {
    var best = null, area = 0;
    canvases(document, [], 0).forEach(function (c) {
      var r = c.getBoundingClientRect();
      var a = r.width * r.height;
      if (r.width > 60 && r.height > 60 && a > area) { area = a; best = c; }
    });
    return best;
  }

  function release() {
    clearInterval(timer); timer = 0;
    clearInterval(recheck); recheck = 0;
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
    stream = null;
    if (vid) { try { vid.srcObject = null; } catch (e) {} }
    vid = null; canvas = null; busy = false;
  }

  function attach(c) {
    release();
    canvas = c;
    /* captureStream copies what the game actually shows, including WebGL
       games that clear their drawing buffer after every frame. */
    try { stream = c.captureStream(FPS); } catch (e) { stream = null; }
    if (stream) {
      vid = document.createElement('video');
      vid.muted = true;
      vid.playsInline = true;
      vid.srcObject = stream;
      var p = vid.play();
      if (p && p.catch) p.catch(function () {});
    }
    if (!out) { out = document.createElement('canvas'); octx = out.getContext('2d'); }
    timer = setInterval(grab, Math.round(1000 / FPS));
    /* Some games swap their canvas (a menu, then the level). */
    recheck = setInterval(function () {
      var b = biggest();
      if (b && b !== canvas) attach(b);
    }, 5000);
  }

  function grab() {
    if (busy || !canvas) return;
    var src = canvas, w = canvas.width, h = canvas.height;
    if (vid && vid.videoWidth) { src = vid; w = vid.videoWidth; h = vid.videoHeight; }
    if (!w || !h) return;
    var s = Math.min(1, MAXW / w);
    var ow = Math.max(1, Math.round(w * s)), oh = Math.max(1, Math.round(h * s));
    if (out.width !== ow) out.width = ow;
    if (out.height !== oh) out.height = oh;
    try { octx.drawImage(src, 0, 0, ow, oh); } catch (e) { return; }
    busy = true;
    try {
      out.toBlob(function (b) {
        if (!b || !timer) { busy = false; return; }
        b.arrayBuffer().then(function (ab) {
          busy = false;
          if (timer) say({ xnWatch: 'frame', b: ab }, [ab]);
        }, function () { busy = false; });
      }, 'image/jpeg', Q);
    } catch (e) {
      /* The canvas holds pictures from another site; the browser won't let
         anything read it. */
      busy = false;
      release();
      say({ xnWatch: 'nope' });
    }
  }

  function start() {
    clearTimeout(retry);
    if (timer) return;
    var c = biggest();
    if (c) { tries = 0; attach(c); return; }
    /* Still loading: look again for a while, then give up. */
    if (++tries > 10) { tries = 0; say({ xnWatch: 'nope' }); return; }
    retry = setTimeout(start, 2000);
  }
  function stop() {
    clearTimeout(retry);
    tries = 0;
    release();
  }

  function onMessage(e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.xnWatch !== 'string') return;
    parentOrigin = e.origin || '*';
    if (d.xnWatch === 'start') start();
    else if (d.xnWatch === 'stop') stop();
  }
  window.addEventListener('message', onMessage);
  /* Some launchers unzip the game and replace this whole page with
     document.open() + document.write() (Retro Bowl Multiplayer does). That
     wipes every listener on the window, so listen again afterwards, drop the
     old page's canvas, and tell the Xenon page we're back so it can say
     "start" again if someone is watching. */
  try {
    var open0 = Document.prototype.open;
    Document.prototype.open = function () {
      var r = open0.apply(this, arguments);
      if (this === document) {
        window.removeEventListener('message', onMessage);
        window.addEventListener('message', onMessage);
        var was = !!(timer || retry);
        stop();
        if (was) setTimeout(start, 1500);
        setTimeout(function () { say({ xnWatch: 'ready' }); }, 1500);
      }
      return r;
    };
  } catch (e) { /* a locked-down page: watching just won't survive a rewrite */ }
  /* Tell the page this game can be watched, so a viewer who was already
     waiting gets frames as soon as the game loads. */
  say({ xnWatch: 'ready' });
})();
