/* Xenon browser shell: tabs, bookmarks, address bar, two proxy engines. */
(function () {
  var boot = document.getElementById('boot');
  var bootmsg = document.getElementById('bootmsg');
  var shell = document.getElementById('shell');
  var tabsEl = document.getElementById('tabs');
  var viewsEl = document.getElementById('views');
  var urlEl = document.getElementById('url');
  var starEl = document.getElementById('star');
  var bmEl = document.getElementById('bookmarks');
  var engineEl = document.getElementById('engine');

  function say(t) { if (bootmsg) bootmsg.textContent = t; }
  function pref(k, d) { try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {} return d; }
  function pset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); if (v) return v; } catch (e) {} return d; }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var engine = pref('xenon-engine', 'uv');
  if (engine !== 'scramjet') engine = 'uv';
  engineEl.value = engine;

  /* ---------- url helpers ---------- */
  function toTarget(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.indexOf(' ') === -1 && v.indexOf('.') > 0) return 'https://' + v;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
  }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function favicon(u) {
    var h = hostOf(u);
    return h ? 'https://icons.duckduckgo.com/ip3/' + h + '.ico' : '';
  }

  var sjController = null;
  function proxied(url) {
    if (engine === 'scramjet' && sjController) return sjController.encodeUrl(url);
    return __uv$config.prefix + __uv$config.encodeUrl(url);
  }
  function unproxy(path) {
    try {
      if (path.indexOf(__uv$config.prefix) === 0) {
        return __uv$config.decodeUrl(path.slice(__uv$config.prefix.length));
      }
      if (path.indexOf('/scramjet/') === 0) {
        return decodeURIComponent(path.slice('/scramjet/'.length));
      }
    } catch (e) {}
    return null;
  }

  /* ---------- tabs ---------- */
  var tabs = [];
  var activeId = null;
  var nextId = 1;

  function activeTab() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === activeId) return tabs[i];
    return null;
  }

  function newTab(url, focus) {
    var tab = { id: nextId++, url: url || null, title: url ? hostOf(url) : 'New tab', history: [], hi: -1, frame: null };
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; fullscreen; clipboard-read; clipboard-write');
    f.hidden = true;
    viewsEl.appendChild(f);
    tab.frame = f;
    tabs.push(tab);
    if (url) go(tab, url);
    else showNewTabPage(tab);
    if (focus !== false) select(tab.id);
    renderTabs();
    return tab;
  }

  function showNewTabPage(tab) {
    tab.frame.removeAttribute('src');
    tab.frame.srcdoc =
      '<!doctype html><meta charset=utf-8>' +
      '<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;' +
      'background:#05070e;color:#eef3ff;font:15px "Leelawadee UI","Segoe UI",system-ui,sans-serif}' +
      'h2{font-size:2.6rem;font-weight:700;letter-spacing:.05em;margin:0;opacity:.9}</style>' +
      '<h2>xenon</h2>';
  }

  function closeTab(id) {
    var i = -1;
    for (var k = 0; k < tabs.length; k++) if (tabs[k].id === id) i = k;
    if (i === -1) return;
    var t = tabs[i];
    if (t.frame && t.frame.parentNode) t.frame.parentNode.removeChild(t.frame);
    tabs.splice(i, 1);
    if (activeId === id) {
      if (tabs.length) select(tabs[Math.max(0, i - 1)].id);
      else { newTab(null); return; }
    }
    renderTabs();
  }

  function select(id) {
    activeId = id;
    for (var i = 0; i < tabs.length; i++) tabs[i].frame.hidden = (tabs[i].id !== id);
    var t = activeTab();
    if (t) { urlEl.value = t.url || ''; syncStar(); }
    renderTabs();
    updateNavButtons();
  }

  function go(tab, url) {
    tab.url = url;
    tab.title = hostOf(url) || url;
    tab.history = tab.history.slice(0, tab.hi + 1);
    tab.history.push(url);
    tab.hi = tab.history.length - 1;
    tab.frame.removeAttribute('srcdoc');
    tab.frame.src = proxied(url);
    if (tab.id === activeId) { urlEl.value = url; syncStar(); }
    renderTabs();
    updateNavButtons();
  }

  /* navigate without pushing history (used by back / forward / reload) */
  function loadInto(tab, url) {
    tab.url = url;
    tab.frame.removeAttribute('srcdoc');
    tab.frame.src = proxied(url);
    if (tab.id === activeId) { urlEl.value = url; syncStar(); }
    renderTabs();
    updateNavButtons();
  }

  function renderTabs() {
    tabsEl.textContent = '';
    tabs.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' on' : '');
      if (t.url) {
        var img = document.createElement('img');
        img.src = favicon(t.url);
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
        el.appendChild(img);
      }
      var s = document.createElement('span');
      s.className = 't';
      s.textContent = t.title || 'New tab';
      el.appendChild(s);
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = 'x';
      x.title = 'Close tab';
      x.addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(t.id); });
      el.appendChild(x);
      el.addEventListener('click', function () { select(t.id); });
      tabsEl.appendChild(el);
    });
  }

  function updateNavButtons() {
    var t = activeTab();
    document.getElementById('back').disabled = !(t && t.hi > 0);
    document.getElementById('fwd').disabled = !(t && t.hi < t.history.length - 1);
  }

  /* ---------- bookmarks ---------- */
  var BM = 'xenon-bookmarks';
  function bookmarks() { return jget(BM, []); }
  function isBookmarked(u) {
    var b = bookmarks();
    for (var i = 0; i < b.length; i++) if (b[i].url === u) return true;
    return false;
  }
  function syncStar() {
    var t = activeTab();
    var on = !!(t && t.url && isBookmarked(t.url));
    if (on) starEl.classList.add('on'); else starEl.classList.remove('on');
    starEl.innerHTML = on ? '&#9733;' : '&#9734;';
  }
  function renderBookmarks() {
    bmEl.textContent = '';
    var list = bookmarks();
    if (!list.length) {
      var p = document.createElement('span');
      p.id = 'bm-empty';
      p.textContent = 'No bookmarks yet - open a site and press the star';
      bmEl.appendChild(p);
      return;
    }
    list.forEach(function (b, i) {
      var el = document.createElement('div');
      el.className = 'bm';
      var img = document.createElement('img');
      img.src = favicon(b.url);
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      el.appendChild(img);
      var s = document.createElement('span');
      s.textContent = b.title || hostOf(b.url);
      el.appendChild(s);
      var rm = document.createElement('span');
      rm.className = 'rm';
      rm.textContent = 'x';
      rm.title = 'Remove bookmark';
      rm.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var l = bookmarks(); l.splice(i, 1); jset(BM, l); renderBookmarks(); syncStar();
      });
      el.appendChild(rm);
      el.addEventListener('click', function () {
        var t = activeTab();
        if (t) go(t, b.url); else newTab(b.url);
      });
      bmEl.appendChild(el);
    });
  }

  starEl.addEventListener('click', function () {
    var t = activeTab();
    if (!t || !t.url) return;
    var l = bookmarks();
    var found = -1;
    for (var i = 0; i < l.length; i++) if (l[i].url === t.url) found = i;
    if (found >= 0) l.splice(found, 1);
    else l.push({ url: t.url, title: t.title || hostOf(t.url) });
    jset(BM, l);
    renderBookmarks();
    syncStar();
  });

  /* ---------- toolbar ---------- */
  urlEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var u = toTarget(urlEl.value);
    if (!u) return;
    var t = activeTab();
    if (t) go(t, u); else newTab(u);
  });
  document.getElementById('newtab').addEventListener('click', function () { newTab(null); urlEl.focus(); });
  document.getElementById('reload').addEventListener('click', function () {
    var t = activeTab();
    if (t && t.url) loadInto(t, t.url);
  });
  document.getElementById('back').addEventListener('click', function () {
    var t = activeTab();
    if (t && t.hi > 0) { t.hi--; loadInto(t, t.history[t.hi]); }
  });
  document.getElementById('fwd').addEventListener('click', function () {
    var t = activeTab();
    if (t && t.hi < t.history.length - 1) { t.hi++; loadInto(t, t.history[t.hi]); }
  });
  engineEl.addEventListener('change', function () {
    engine = engineEl.value;
    pset('xenon-engine', engine);
    var t = activeTab();
    if (engine === 'scramjet') {
      initScramjet().then(function () { if (t && t.url) loadInto(t, t.url); }).catch(function () {});
    } else if (t && t.url) {
      loadInto(t, t.url);
    }
  });

  document.addEventListener('keydown', function (e) {
    var meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key === 't') { e.preventDefault(); newTab(null); urlEl.focus(); }
    else if (e.key === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (e.key === 'l') { e.preventDefault(); urlEl.focus(); urlEl.select(); }
    else if (e.key === 'd') { e.preventDefault(); starEl.click(); }
  });

  /* Keep tab title and address bar in step with what the frame actually shows.
     The frames are same-origin (they are /service/ URLs on this host), so we
     can read their document directly. */
  setInterval(function () {
    tabs.forEach(function (t) {
      if (!t.frame) return;
      var doc, loc;
      try { doc = t.frame.contentDocument; loc = t.frame.contentWindow.location; } catch (e) { return; }
      if (!doc || !loc) return;
      if (doc.title && doc.title !== t.title) { t.title = doc.title; renderTabs(); }
      var real = unproxy(loc.pathname);
      if (real && real !== t.url) {
        t.url = real;
        if (t.hi < 0 || t.history[t.hi] !== real) {
          t.history = t.history.slice(0, t.hi + 1);
          t.history.push(real);
          t.hi = t.history.length - 1;
        }
        if (t.id === activeId) { urlEl.value = real; syncStar(); }
        updateNavButtons();
      }
    });
  }, 800);

  /* ---------- boot ---------- */
  function withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error(label)); }, ms); })
    ]);
  }

  /* Wipe every bit of state that can wedge the boot: the service worker,
     caches, scramjet's IndexedDB, and the one-shot reload flag. */
  async function hardReset() {
    try {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var i = 0; i < regs.length; i++) await regs[i].unregister();
    } catch (e) {}
    try { if (window.caches) { var ks = await caches.keys(); for (var j = 0; j < ks.length; j++) await caches.delete(ks[j]); } } catch (e) {}
    try { sessionStorage.removeItem('xenon-sw-reload'); } catch (e) {}
    try { localStorage.removeItem('bare-mux-path'); } catch (e) {}
    try {
      if (window.indexedDB && indexedDB.databases) {
        var dbs = await indexedDB.databases();
        for (var k = 0; k < dbs.length; k++) {
          if (!dbs[k].name) continue;
          await new Promise(function (res) {
            var rq = indexedDB.deleteDatabase(dbs[k].name);
            rq.onsuccess = rq.onerror = rq.onblocked = function () { res(); };
            setTimeout(res, 1500);
          });
        }
      }
    } catch (e) {}
  }

  function bootFailed(msg) {
    say(msg);
    var btn = document.getElementById('bootreset');
    if (!btn) return;
    btn.hidden = false;
    btn.onclick = async function () {
      btn.disabled = true;
      say('clearing worker and caches');
      await hardReset();
      location.replace(location.pathname + location.search);
    };
  }

  function initScramjet() {
    if (sjController) return Promise.resolve(sjController);
    var ctl = $scramjetLoadController();
    var c = new ctl.ScramjetController({
      prefix: '/scramjet/',
      files: { wasm: '/scram/scramjet.wasm.wasm', all: '/scram/scramjet.all.js', sync: '/scram/scramjet.sync.js' }
    });
    return Promise.race([
      c.init(),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('scramjet init timed out')); }, 12000); })
    ]).then(function () { sjController = c; return c; });
  }

  /* Last-resort watchdog: if the boot screen is still up after 25s, something
     hung that we did not anticipate. Offer the reset rather than sitting on
     "opening transport" forever. */
  setTimeout(function () {
    if (boot && !boot.hidden && document.getElementById('bootreset').hidden) {
      bootFailed('stuck on "' + bootmsg.textContent + '" - press Reset and retry');
    }
  }, 25000);

  (async function start() {
    try {
      if (!navigator.serviceWorker) throw new Error('needs https or localhost');
      say('registering worker');
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      if (!navigator.serviceWorker.controller) {
        say('waiting for worker');
        await new Promise(function (res) {
          var done = false, waited = 0;
          function fin() { if (!done) { done = true; res(); } }
          navigator.serviceWorker.addEventListener('controllerchange', fin);
          (function tick() {
            if (done) return;
            if (navigator.serviceWorker.controller) return fin();
            waited += 200;
            if (waited >= 3000) return fin();
            setTimeout(tick, 200);
          })();
        });
      }
      if (!navigator.serviceWorker.controller) {
        var flag = 'xenon-sw-reload', already = false;
        try { already = sessionStorage.getItem(flag) === '1'; } catch (e) {}
        if (!already) {
          try { sessionStorage.setItem(flag, '1'); } catch (e) {}
          say('reloading to attach worker');
          location.reload();
          await new Promise(function () {});
        }
      }
      try { sessionStorage.removeItem('xenon-sw-reload'); } catch (e) {}

      say('opening transport');
      if (typeof SharedWorker === 'undefined') {
        throw new Error('this browser has SharedWorker disabled, which bare-mux needs');
      }
      // setTransport can hang forever if the worker port never arrives, which
      // leaves the boot screen stuck on "opening transport". Bound it.
      var conn = new BareMux.BareMuxConnection('/baremux/worker.js');
      await withTimeout(
        conn.setTransport('/baremod/index.mjs', [location.origin + '/bare/']),
        15000,
        'transport did not open in 15s - press Reset and retry'
      );

      var qs = new URLSearchParams(location.search);
      var e = qs.get('e');
      if (e === 'scramjet' || e === 'uv') {
        engine = e;
        engineEl.value = e;
        pset('xenon-engine', e);
      }
      if (engine === 'scramjet') {
        say('starting scramjet');
        try { await initScramjet(); } catch (x) { engine = 'uv'; engineEl.value = 'uv'; }
      }

      boot.hidden = true;
      shell.hidden = false;
      renderBookmarks();

      var first = qs.get('u');
      newTab(first ? toTarget(first) : null);
      if (!first) urlEl.focus();
    } catch (err) {
      bootFailed(String(err.message || err));
    }
  })();
})();
