/* Xenon clip agent. Injected at the top of every game page under /g/, and
 * loaded by the proxy's browser page so web games can be clipped too.
 *
 * Does nothing until the portal around the game sends {xnClip:'arm'}, which it
 * only does for people who turned clipping on. Then it records the game's own
 * canvas - not the page around it - plus whatever the game plays through Web
 * Audio, into a rolling buffer of the last N seconds. {xnClip:'save'} cuts a
 * clip from that buffer and posts it back as a Blob.
 *
 * The game's canvas is looked for everywhere this page can reach: inside
 * shadow DOM (Ruffle draws Flash games in one) and inside same-site frames
 * (wrapper pages, and the proxied page a web game runs in). Only the agent the
 * portal arms records; agents in inner frames just tap their frame's audio.
 *
 * The cut is made at a cluster boundary of the WebM stream. The recorder is
 * asked for a keyframe every two seconds, and Chrome starts a new cluster on
 * every keyframe, so a cluster start is always a clean place to begin. The
 * clusters' timestamps are shifted so the clip starts at zero, and a Duration
 * is written into the header so the clip can be seeked.
 */
(function () {
  'use strict';
  if (window.top === window) return;
  if (window.__xnClip) return;
  window.__xnClip = true;

  /* Audio tap. Every node connected to a context's speakers is also connected
     to a stream destination, so the recording hears what the player hears.
     Patched before the game's own scripts run, which is why this file is the
     first thing in <head>. */
  var taps = [];
  var onNewTap = null;
  /* An agent in an outer frame reads this frame's taps from here. */
  window.__xnTaps = taps;
  try {
    var AN = window.AudioNode;
    var ADN = window.AudioDestinationNode;
    if (AN && ADN && AN.prototype.connect) {
      var connect = AN.prototype.connect;
      var tapFor = function (ctx) {
        for (var i = 0; i < taps.length; i++) { if (taps[i].ctx === ctx) return taps[i].node; }
        if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
        var node = ctx.createMediaStreamDestination();
        taps.push({ ctx: ctx, node: node });
        if (onNewTap) onNewTap();
        return node;
      };
      AN.prototype.connect = function (dest) {
        var r = connect.apply(this, arguments);
        try {
          if (dest instanceof ADN) {
            var t = tapFor(this.context);
            if (t) connect.call(this, t);
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}

  var cfg = { seconds: 30, fps: 30, bitrate: 3500000 };
  var armed = false;
  var canvas = null;
  var rec = null;
  var header = null;
  var pending = null;
  var chain = Promise.resolve();
  var ring = [];
  var startedAt = 0;
  var lookTimer = null;
  var foreign = false;
  var armedAt = 0;
  var toldForeign = false;

  function tell(msg) {
    msg.xnClip = msg.xnClip || 'state';
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  /* Every document this page can reach: its own, plus same-site frames, all
     the way down. A frame from another site cannot be read; noted so the
     player gets a real reason instead of "no canvas". */
  function documents() {
    var out = [], seen = [];
    foreign = false;
    (function walk(doc, depth) {
      if (!doc || seen.indexOf(doc) >= 0 || depth > 6) return;
      seen.push(doc);
      out.push(doc);
      var frames = doc.querySelectorAll('iframe,frame');
      for (var i = 0; i < frames.length; i++) {
        var d = null;
        try { d = frames[i].contentDocument; } catch (e) {}
        if (d) walk(d, depth + 1);
        else if (frames[i].getBoundingClientRect().width > 120) foreign = true;
      }
    })(document, 0);
    return out;
  }

  /* Canvases in a document, including ones inside open shadow roots. */
  function canvasesIn(root, out, depth) {
    var list = root.querySelectorAll('canvas');
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    if (depth > 4) return;
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) canvasesIn(all[j].shadowRoot, out, depth + 1);
    }
  }

  function biggestCanvas() {
    var best = null, area = 0;
    var docs = documents();
    for (var d = 0; d < docs.length; d++) {
      var list = [];
      try { canvasesIn(docs[d], list, 0); } catch (e) { continue; }
      for (var i = 0; i < list.length; i++) {
        var r = list[i].getBoundingClientRect();
        var a = r.width * r.height;
        if (a > area && r.width > 120 && r.height > 90) { best = list[i]; area = a; }
      }
      hookKeys(docs[d]);
    }
    return best;
  }

  /* Audio taps from this frame and every reachable inner frame with an agent. */
  function allTaps() {
    var out = taps.slice();
    var docs = documents();
    for (var d = 1; d < docs.length; d++) {
      try {
        var t = docs[d].defaultView && docs[d].defaultView.__xnTaps;
        if (t) out = out.concat(t);
      } catch (e) {}
    }
    return out;
  }

  function mime() {
    var list = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    for (var i = 0; i < list.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  function stop() {
    if (rec) { try { rec.ondataavailable = null; rec.stop(); } catch (e) {} }
    rec = null;
    header = null;
    pending = null;
    chain = Promise.resolve();
    ring = [];
  }

  function start() {
    stop();
    if (!armed || !canvas || !canvas.captureStream) return;
    var type = mime();
    if (!type) { tell({ ok: false, why: 'this browser cannot record' }); return; }
    var stream;
    try { stream = canvas.captureStream(cfg.fps); } catch (e) {
      /* A canvas showing another site's images refuses to be recorded. */
      tell({ ok: false, why: 'this game blocks recording' });
      return;
    }
    var tl = allTaps();
    for (var i = 0; i < tl.length; i++) {
      var tracks = tl[i].node.stream.getAudioTracks();
      if (tracks[0]) { stream.addTrack(tracks[0]); break; }
    }
    try {
      rec = new MediaRecorder(stream, {
        mimeType: type,
        videoBitsPerSecond: cfg.bitrate,
        audioBitsPerSecond: 128000,
        videoKeyFrameIntervalDuration: 2000
      });
    } catch (e) {
      tell({ ok: false, why: 'recorder would not start' });
      return;
    }
    startedAt = performance.now();
    var mine = rec;
    rec.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      var at = performance.now();
      /* Strictly in order: reading a Blob is async, and two chunks read side
         by side can finish the wrong way round. */
      chain = chain.then(function () { return e.data.arrayBuffer(); })
        .then(function (ab) { if (rec === mine) take(new Uint8Array(ab), at); })
        .catch(function () {});
    };
    rec.start(1000);
    tell({ ok: true, armed: true, audio: stream.getAudioTracks().length > 0 });
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /* The stream opens with the WebM header, then clusters. Chrome can hand the
     header over in pieces (its first chunk is sometimes a single byte), so
     bytes are gathered until the first cluster shows up; everything before it
     is the header, kept for good, and the rest goes into the ring. */
  function take(bytes, now) {
    if (!header) {
      pending = pending ? concat(pending, bytes) : bytes;
      var at = findCluster(pending, 0);
      if (at < 0) {
        if (pending.length > 8e6) start();
        return;
      }
      if (pending[0] !== 0x1a || pending[1] !== 0x45 || pending[2] !== 0xdf || pending[3] !== 0xa3) { start(); return; }
      header = pending.slice(0, at);
      bytes = pending.slice(at);
      pending = null;
    }
    ring.push({ t: now, b: bytes });
    var keep = (cfg.seconds + 6) * 1000;
    while (ring.length > 1 && now - ring[0].t > keep) ring.shift();
  }

  /* Asks the recorder for what it has so far, so a clip runs right up to the
     key press instead of stopping at the last whole second. */
  function flush() {
    return new Promise(function (done) {
      if (!rec || rec.state !== 'recording') { done(); return; }
      var n = ring.length;
      try { rec.requestData(); } catch (e) { done(); return; }
      var t0 = Date.now();
      (function wait() {
        chain.then(function () {
          if (ring.length > n || Date.now() - t0 > 1500) done();
          else setTimeout(wait, 50);
        });
      })();
    });
  }

  function vint(b, i) {
    var first = b[i];
    if (first === undefined) return null;
    var len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || i + len > b.length) return null;
    var val = first & (mask - 1), unknown = val === mask - 1;
    for (var k = 1; k < len; k++) { val = val * 256 + b[i + k]; if (b[i + k] !== 0xff) unknown = false; }
    return { len: len, val: val, unknown: unknown };
  }

  /* A cluster start is the Cluster ID, a size, then a Timecode element. */
  function findCluster(b, from) {
    for (var i = from; i + 6 < b.length; i++) {
      if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) continue;
      var s = vint(b, i + 4);
      if (s && b[i + 4 + s.len] === 0xe7) return i;
    }
    return -1;
  }

  function timecodeAt(b, i) {
    var s = vint(b, i + 4);
    var at = i + 4 + s.len + 1;
    var n = vint(b, at);
    if (!n || n.len !== 1 || n.val < 1 || n.val > 8) return null;
    var v = 0;
    for (var k = 0; k < n.val; k++) v = v * 256 + b[at + 1 + k];
    return { pos: at + 1, size: n.val, value: v };
  }

  /* An element ID is 1-4 bytes, its length marked by the first byte's
     leading bits the same way as a vint. */
  function idLen(first) {
    return first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  }
  function idAt(b, i) {
    var n = idLen(b[i]);
    if (!n || i + n > b.length) return null;
    var v = 0;
    for (var k = 0; k < n; k++) v = v * 256 + b[i + k];
    return { len: n, id: v };
  }

  /* Which track is the video. Read by walking the Tracks element properly:
     scanning for the TrackEntry byte (0xAE) found it inside other IDs - the
     Tracks ID itself is 16 54 AE 6B - and reading every child ID as one byte
     tripped over two-byte ones like TrackUID (73 C5). Depending on the game's
     size, that picked the audio track, and no clip could be cut. */
  function videoTrack(h) {
    for (var i = 0; i + 4 < h.length; i++) {
      if (h[i] !== 0x16 || h[i + 1] !== 0x54 || h[i + 2] !== 0xae || h[i + 3] !== 0x6b) continue;
      var ts = vint(h, i + 4);
      if (!ts) return 1;
      var e = i + 4 + ts.len, end = ts.unknown ? h.length : Math.min(h.length, e + ts.val);
      while (e < end) {
        var te = idAt(h, e);
        if (!te) break;
        var es = vint(h, e + te.len);
        if (!es) break;
        var body = e + te.len + es.len, stop = Math.min(end, body + es.val);
        if (te.id === 0xae) {
          var num = 0, type = 0, c = body;
          while (c < stop) {
            var ce = idAt(h, c);
            if (!ce) break;
            var cs = vint(h, c + ce.len);
            if (!cs) break;
            var cd = c + ce.len + cs.len;
            if (ce.id === 0xd7) num = h[cd];
            if (ce.id === 0x83) type = h[cd];
            c = cd + cs.val;
          }
          if (type === 1 && num) return num;
        }
        e = stop;
      }
      return 1;
    }
    return 1;
  }

  /* Chrome starts clusters between keyframes too, and its container flags
     call every frame a keyframe. The VP8 frame header is what can be
     trusted: bit 0 of its first byte is 0 on a keyframe. For anything that
     is not VP8 the container's word is taken. */
  function startsOnKey(b, at, stop, track, vp8) {
    var s = vint(b, at + 4);
    var j = at + 4 + s.len;
    var tc = vint(b, j + 1);
    j = j + 1 + tc.len + tc.val;
    while (j < stop) {
      var idb = b[j], sz = vint(b, j + 1);
      if (!sz) return false;
      var d = j + 1 + sz.len, blk = -1;
      if (idb === 0xa3) blk = d;
      else if (idb === 0xa0) {
        for (var e = d; e < d + sz.val;) {
          var cs = vint(b, e + 1);
          if (!cs) break;
          if (b[e] === 0xa1) { blk = e + 1 + cs.len; break; }
          e = e + 1 + cs.len + cs.val;
        }
      }
      if (blk >= 0) {
        var tn = vint(b, blk);
        if (tn && tn.val === track) {
          if (vp8) return (b[blk + tn.len + 3] & 1) === 0;
          return idb === 0xa0 || (b[blk + tn.len + 2] & 0x80) !== 0;
        }
      }
      j = d + sz.val;
    }
    return false;
  }

  function writeTimecode(b, tc, value) {
    for (var k = tc.size - 1; k >= 0; k--) { b[tc.pos + k] = value % 256; value = Math.floor(value / 256); }
  }

  function sizeVint(n) {
    var out = [0x08, 0, 0, 0, 0, 0, 0, 0];
    for (var k = 7; k >= 1; k--) { out[k] = n % 256; n = Math.floor(n / 256); }
    out[0] = 0x01;
    return out;
  }

  /* Adds Duration (ms, float64) inside the Info element of the header. */
  function withDuration(h, ms) {
    for (var i = 0; i + 4 < h.length; i++) {
      if (h[i] !== 0x15 || h[i + 1] !== 0x49 || h[i + 2] !== 0xa9 || h[i + 3] !== 0x66) continue;
      var s = vint(h, i + 4);
      if (!s || s.unknown) return h;
      var bodyAt = i + 4 + s.len, end = bodyAt + s.val;
      var dur = new Uint8Array(11);
      dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
      new DataView(dur.buffer).setFloat64(3, ms);
      var size = sizeVint(s.val + dur.length);
      var out = new Uint8Array(h.length + dur.length + size.length - s.len);
      var o = 0;
      out.set(h.subarray(0, i + 4), o); o += i + 4;
      out.set(size, o); o += size.length;
      out.set(h.subarray(bodyAt, end), o); o += end - bodyAt;
      out.set(dur, o); o += dur.length;
      out.set(h.subarray(end), o);
      return out;
    }
    return h;
  }

  function cut() {
    if (!header || !ring.length) return null;
    var total = 0;
    for (var i = 0; i < ring.length; i++) total += ring[i].b.length;
    var body = new Uint8Array(total);
    var o = 0;
    for (var j = 0; j < ring.length; j++) { body.set(ring[j].b, o); o += ring[j].b.length; }

    var starts = [];
    for (var at = findCluster(body, 0); at >= 0; at = findCluster(body, at + 4)) {
      var tc = timecodeAt(body, at);
      if (tc) starts.push({ at: at, tc: tc });
    }
    if (!starts.length) return null;
    var track = videoTrack(header);
    var vp8 = !!(rec && /vp8/i.test(rec.mimeType));
    var keys = [];
    for (var q = 0; q < starts.length; q++) {
      var stop = q + 1 < starts.length ? starts[q + 1].at : body.length;
      if (startsOnKey(body, starts[q].at, stop, track, vp8)) keys.push(starts[q]);
    }
    if (!keys.length) return null;
    var last = starts[starts.length - 1].tc.value;
    var want = last - cfg.seconds * 1000;
    var first = keys[keys.length - 1];
    for (var k = 0; k < keys.length; k++) { if (keys[k].tc.value >= want) { first = keys[k]; break; } }
    if (first.tc.value > want + 2500) {
      for (var k2 = keys.length - 1; k2 >= 0; k2--) { if (keys[k2].tc.value <= want) { first = keys[k2]; break; } }
    }

    var clip = body.slice(first.at);
    var base = first.tc.value;
    for (var m = 0; m < starts.length; m++) {
      if (starts[m].at < first.at) continue;
      var t = starts[m].tc;
      writeTimecode(clip, { pos: t.pos - first.at, size: t.size }, t.value - base);
    }
    var end = (performance.now() - startedAt) - base;
    var head = withDuration(header, Math.max(1000, end));
    return { blob: new Blob([head, clip], { type: 'video/webm' }), dur: Math.round(end / 1000) };
  }

  function look() {
    clearTimeout(lookTimer);
    if (!armed) return;
    var c = biggestCanvas();
    /* A canvas that left the page (the game rebuilt it, or its frame
       reloaded) is let go, and the new one recorded. */
    if (canvas && !canvas.isConnected) { canvas = null; stop(); }
    if (c && c !== canvas) { canvas = c; start(); }
    else if (!c && !canvas) {
      /* A game running in another site's frame can't be reached, and it also
         swallows the clip key, so pressing it would do nothing at all. Said
         once, early, instead. */
      if (foreign && !toldForeign && performance.now() - armedAt > 8000) {
        toldForeign = true;
        tell({ ok: false, armed: true, why: 'this game loads from another site, so it can’t be clipped' });
      } else tell({ ok: false, armed: true, why: 'waiting for the game to draw' });
    }
    lookTimer = setTimeout(look, canvas ? 4000 : 1000);
  }

  window.__xnClipState = function () {
    var bytes = 0;
    for (var i = 0; i < ring.length; i++) bytes += ring[i].b.length;
    return { armed: armed, canvas: !!canvas, rec: rec ? rec.state : null, mime: rec ? rec.mimeType : null, header: header ? header.length : 0, chunks: ring.length, bytes: bytes, audio: allTaps().length, foreign: foreign };
  };

  /* For checking a recording by hand from the console. */
  window.__xnClipDump = function () {
    var parts = header ? [header] : [];
    for (var i = 0; i < ring.length; i++) parts.push(ring[i].b);
    return new Blob(parts, { type: 'video/webm' });
  };
  window.__xnClipDebug = function () {
    var total = 0;
    for (var i = 0; i < ring.length; i++) total += ring[i].b.length;
    var body = new Uint8Array(total), o = 0;
    for (var j = 0; j < ring.length; j++) { body.set(ring[j].b, o); o += ring[j].b.length; }
    var starts = [];
    for (var at = findCluster(body, 0); at >= 0; at = findCluster(body, at + 4)) {
      var tc = timecodeAt(body, at);
      starts.push({ at: at, tc: tc ? tc.value : null });
    }
    var track = header ? videoTrack(header) : 0;
    var vp8 = !!(rec && /vp8/i.test(rec.mimeType)), keys = 0;
    for (var q = 0; q < starts.length; q++) {
      if (starts[q].tc === null) continue;
      var stop = q + 1 < starts.length ? starts[q + 1].at : body.length;
      if (startsOnKey(body, starts[q].at, stop, track, vp8)) keys++;
    }
    return { bytes: total, clusters: starts.length, withTimecode: starts.filter(function (s) { return s.tc !== null; }).length, keys: keys, track: track, vp8: vp8, firstTc: starts.length ? starts[0].tc : null, lastTc: starts.length ? starts[starts.length - 1].tc : null };
  };

  onNewTap = function () {
    if (rec && rec.stream && !rec.stream.getAudioTracks().length) setTimeout(start, 50);
  };

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || !d.xnClip) return;
    if (d.xnClip === 'arm') {
      if (d.seconds) cfg.seconds = Math.max(5, Math.min(120, d.seconds | 0));
      if (d.fps) cfg.fps = Math.max(15, Math.min(60, d.fps | 0));
      if (d.bitrate) cfg.bitrate = Math.max(800000, Math.min(12000000, d.bitrate | 0));
      if (d.key && typeof d.key === 'object' && typeof d.key.code === 'string') clipKey = d.key;
      if (!armed) armedAt = performance.now();
      armed = true;
      look();
    } else if (d.xnClip === 'disarm') {
      armed = false;
      clearTimeout(lookTimer);
      stop();
    } else if (d.xnClip === 'save') {
      flush().then(function () {
        var out = null;
        try { out = cut(); } catch (err) { out = null; }
        if (out) { tell({ xnClip: 'clip', blob: out.blob, dur: out.dur, title: document.title || '' }); return; }
        var why = 'this game does not draw to a canvas';
        if (canvas) why = ring.length ? 'the recording got scrambled - try again in a few seconds' : 'nothing recorded yet - give it a few seconds';
        else if (foreign) why = 'this game loads from another site, which cannot be recorded';
        tell({ xnClip: 'clip', error: why });
      });
    }
  });

  /* The clip key is the player's choice, sent with every 'arm'. Matched on
     the physical key plus modifiers, so keyboard layout does not matter.
     Listened for in every reachable frame: the key goes to whichever frame
     has focus, and a game in an inner frame (a wrapper page, a proxied web
     game) would otherwise swallow it. */
  var clipKey = { code: 'F8' };
  function onKey(e) {
    if (e.code !== clipKey.code) return;
    if (!!clipKey.ctrl !== e.ctrlKey || !!clipKey.alt !== e.altKey || !!clipKey.shift !== e.shiftKey) return;
    tell({ xnClip: 'hotkey' });
  }

  /* The game covers the whole screen, so the portal never sees the mouse.
     Moving to the top edge is passed up so it can show its Back button. */
  var lastEdge = 0;
  function onMove(e) {
    if (e.clientY > 60) return;
    var now = Date.now();
    if (now - lastEdge < 400) return;
    lastEdge = now;
    tell({ xnClip: 'edge' });
  }
  var hooked = [];
  function hookKeys(doc) {
    if (hooked.indexOf(doc) >= 0) return;
    hooked.push(doc);
    if (hooked.length > 40) hooked.shift();
    try {
      doc.addEventListener('keydown', onKey, true);
      /* Inner frames are offset in the page, but a game frame starts at the top. */
      doc.addEventListener('mousemove', onMove, { passive: true, capture: true });
    } catch (e) {}
  }
  hookKeys(document);

  document.addEventListener('visibilitychange', function () {
    if (!rec) return;
    try { if (document.hidden) rec.pause(); else rec.resume(); } catch (e) {}
  });

  tell({ xnClip: 'ready' });
})();
