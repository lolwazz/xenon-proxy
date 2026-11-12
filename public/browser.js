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

    /* ---- exit region ---------------------------------------------------
   * "Direct" is this machine, so traffic leaves from the home connection.
   * The others are public wisp relays run by other people: they change the
   * exit address, which is the point, but they can also see the traffic.
   * Both sit behind Cloudflare, so their real location is not knowable from
   * here - hence honest labels rather than invented city names.
   */
  var REGIONS = [
    { id: 'direct', name: 'Direct', sub: 'This PC', ico: '\u{1F3E0}', wisp: null },
    { id: 'mercury', name: 'Mercury', sub: 'Public relay', ico: '\u{1F310}', wisp: 'wss://wisp.mercurywork.shop/' },
    { id: 'anura', name: 'Anura', sub: 'Public relay', ico: '\u{1F310}', wisp: 'wss://anura.pro/' }
  ];

  function currentRegion() {
    var id = pref('xenon-region', 'direct');
    for (var i = 0; i < REGIONS.length; i++) { if (REGIONS[i].id === id) return REGIONS[i]; }
    return REGIONS[0];
  }

  function paintRegion() {
    var r = currentRegion();
    var nameEl = document.getElementById('regionname');
    var dotEl = document.getElementById('regiondot');
    if (nameEl) nameEl.textContent = r.name;
    if (dotEl) dotEl.className = r.wisp ? 'relay' : '';
  }

  function buildRegionMenu() {
    var btn = document.getElementById('region');
    var menu = document.getElementById('regionmenu');
    var list = document.getElementById('regionlist');
    if (!btn || !menu || !list) return;

    REGIONS.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rm-item';
      var ico = document.createElement('span'); ico.className = 'rm-ico'; ico.textContent = r.ico;
      var txt = document.createElement('span'); txt.className = 'rm-txt';
      var nm = document.createElement('span'); nm.className = 'rm-name'; nm.textContent = r.name;
      var sb = document.createElement('span'); sb.className = 'rm-sub'; sb.textContent = r.sub;
      var on = document.createElement('span'); on.className = 'rm-on';
      txt.appendChild(nm); txt.appendChild(sb);
      b.appendChild(ico); b.appendChild(txt); b.appendChild(on);
      b.addEventListener('click', function () {
        if (currentRegion().id === r.id) { menu.hidden = true; return; }
        pset('xenon-region', r.id);
        /* Open tabs are still bound to the old route, so reload rather than
           pretend the switch applied to them. */
        location.reload();
      });
      list.appendChild(b);
    });

    function mark() {
      var id = currentRegion().id;
      var items = list.querySelectorAll('.rm-item');
      for (var i = 0; i < items.length; i++) {
        if (REGIONS[i].id === id) items[i].classList.add('on');
        else items[i].classList.remove('on');
      }
    }

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      mark();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', function (ev) {
      if (menu.hidden) return;
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !menu.hidden) {
        menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      }
    });
    paintRegion();
  }
  buildRegionMenu();

  var engine = pref('xenon-engine', 'uv');
  // Anything unrecognised falls back to the default rather than breaking.
  if (engine !== 'scramjet') engine = 'uv';
  engineEl.value = engine;

  /* ---------- url helpers ---------- */
  function toTarget(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.indexOf(' ') === -1 && v.indexOf('.') > 0) return 'https://' + v;
    // The Render backup (PC off) cannot load DuckDuckGo, so it searches Google.
    if (/^go\.zpack\.beauty$|\.onrender\.com$/.test(location.hostname)) return 'https://www.google.com/search?q=' + encodeURIComponent(v);
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
  }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function favicon(u) {
    var h = hostOf(u);
    /* Through this server's /img relay, so the browser only talks to us. */
    return h ? '/img?u=' + encodeURIComponent('https://icons.duckduckgo.com/ip3/' + h + '.ico') : '';
  }

  var sjController = null;
  /* YouTube goes to Invidious (inv.nadeko.net): same paths, no Google.
     sw.js does the same for links clicked inside proxied pages. */
  function xnYt(u) {
    try {
      var w = new URL(u), h = w.hostname.toLowerCase().replace(/^www\./, ''), q = w.search;
      if (h === 'youtu.be') return 'https://inv.nadeko.net/watch?v=' + w.pathname.split('/')[1] + (q ? '&' + q.slice(1) : '');
      if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
        var m = /^\/(shorts|embed|live|v)\/([\w-]{6,})/.exec(w.pathname);
        if (m) return 'https://inv.nadeko.net/watch?v=' + m[2] + (q ? '&' + q.slice(1) : '');
        return 'https://inv.nadeko.net' + w.pathname + q + w.hash;
      }
    } catch (e) {}
    return u;
  }
  function proxied(url) {
    url = xnYt(url);
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
    var tab = { id: nextId++, url: url || null, title: url ? hostOf(url) : 'New tab', history: [], hi: -1, frame: null, loading: false };
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; fullscreen; clipboard-read; clipboard-write');
    // No allow-popups: stops pop-under ad tabs, which streaming and game
    // sites throw on load. Everything a real page needs is still granted.
    // allow-modals is there for bookmarklets, most of which talk through
    // alert() and prompt().
    f.setAttribute('sandbox',
      'allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock allow-downloads allow-modals');
    f.hidden = true;
    f.addEventListener('load', function () {
      if (!tab.url) return;
      tab.loading = false;
      renderTabs();
      updateView();
      if (window.XBT && XBT.onFrameLoad) XBT.onFrameLoad(tab);
    });
    viewsEl.appendChild(f);
    tab.frame = f;
    tabs.push(tab);
    if (url) go(tab, url);
    else showNewTabPage(tab);
    if (focus !== false) select(tab.id);
    renderTabs();
    return tab;
  }

  /* The new tab page is part of this document, not the frame, so it can use
     the shell's own search box, tiles and tools. The frame stays blank and
     hidden behind it until the tab is pointed somewhere. */
  function showNewTabPage(tab) {
    tab.frame.removeAttribute('src');
    tab.frame.removeAttribute('srcdoc');
    tab.url = null;
    tab.title = 'New tab';
    tab.loading = false;
    if (tab.id === activeId) { urlEl.value = ''; syncStar(); }
    renderTabs();
    updateView();
  }

  var ntpEl = document.getElementById('ntp');
  var loadbarEl = document.getElementById('loadbar');
  var omniIco = document.getElementById('omniico');
  function updateView() {
    var t = activeTab();
    var blank = !t || !t.url;
    ntpEl.hidden = !blank;
    for (var i = 0; i < tabs.length; i++) tabs[i].frame.hidden = (tabs[i].id !== activeId) || blank;
    if (t && t.loading) loadbarEl.classList.add('on'); else loadbarEl.classList.remove('on');
    var secure = !!(t && t.url && /^https:/i.test(t.url));
    omniIco.className = secure ? 'secure' : '';
    omniIco.textContent = t && t.url ? (secure ? '🔒' : 'ⓘ') : '🔍';
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
    var t = activeTab();
    if (t) { urlEl.value = t.url || ''; syncStar(); }
    renderTabs();
    updateNavButtons();
    updateView();
  }

  function go(tab, url) {
    url = xnYt(url);
    tab.url = url;
    tab.title = hostOf(url) || url;
    tab.history = tab.history.slice(0, tab.hi + 1);
    tab.history.push(url);
    tab.hi = tab.history.length - 1;
    tab.frame.removeAttribute('srcdoc');
    tab.loading = true;
    tab.frame.src = proxied(url);
    if (tab.id === activeId) { urlEl.value = url; syncStar(); }
    renderTabs();
    updateNavButtons();
    updateView();
  }

  /* navigate without pushing history (used by back / forward / reload) */
  function loadInto(tab, url) {
    url = xnYt(url);
    tab.url = url;
    tab.frame.removeAttribute('srcdoc');
    tab.loading = true;
    tab.frame.src = proxied(url);
    if (tab.id === activeId) { urlEl.value = url; syncStar(); }
    renderTabs();
    updateNavButtons();
    updateView();
  }

  function renderTabs() {
    tabsEl.textContent = '';
    tabs.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' on' : '');
      if (t.loading) {
        var sp = document.createElement('span');
        sp.className = 'spin';
        el.appendChild(sp);
      } else if (t.url) {
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
  /* A list of links {url, title} and folders {title, items: [...]}. Folders
     come from imported bookmark files and open as a menu under their chip. */
  var BM = 'xenon-bookmarks';
  function bookmarks() { return jget(BM, []); }
  function isFolder(b) { return !!(b && b.items && typeof b.items.length === 'number'); }
  function isBookmarklet(u) { return /^javascript:/i.test(u || ''); }
  function findUrl(list, u) {
    for (var i = 0; i < list.length; i++) {
      if (isFolder(list[i]) ? findUrl(list[i].items, u) : list[i].url === u) return true;
    }
    return false;
  }
  function isBookmarked(u) { return findUrl(bookmarks(), u); }
  /* Every copy of a link goes, folders included, so the star always undoes. */
  function dropUrl(list, u) {
    return list.filter(function (b) {
      if (isFolder(b)) { b.items = dropUrl(b.items, u); return true; }
      return b.url !== u;
    });
  }
  function countLinks(list) {
    var n = 0;
    list.forEach(function (b) { n += isFolder(b) ? countLinks(b.items) : 1; });
    return n;
  }
  function openBookmark(b) {
    if (isBookmarklet(b.url)) {
      /* Browsers percent-decode a javascript: URL before running it. */
      var code = b.url.slice(11);
      try { code = decodeURIComponent(code); } catch (e) {}
      if (window.XBT && XBT.run) XBT.run(code);
      return;
    }
    var t = activeTab();
    if (t) go(t, b.url); else newTab(b.url);
  }
  function syncStar() {
    var t = activeTab();
    var on = !!(t && t.url && isBookmarked(t.url));
    if (on) starEl.classList.add('on'); else starEl.classList.remove('on');
    starEl.innerHTML = on ? '&#9733;' : '&#9734;';
  }
  /* The little icon in front of a bookmark: its site's favicon, or a bolt for
     a bookmarklet. */
  function bmIcon(b) {
    if (isBookmarklet(b.url)) {
      var z = document.createElement('span');
      z.textContent = '⚡';
      return z;
    }
    var img = document.createElement('img');
    img.src = favicon(b.url);
    img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
    return img;
  }
  function removeX(title, onRemove) {
    var rm = document.createElement('span');
    rm.className = 'rm';
    rm.textContent = 'x';
    rm.title = title;
    rm.addEventListener('click', function (ev) { ev.stopPropagation(); onRemove(); });
    return rm;
  }
  function linkChip(b, onRemove) {
    var el = document.createElement('div');
    el.className = isBookmarklet(b.url) ? 'bm bk' : 'bm';
    if (isBookmarklet(b.url)) el.title = 'Run bookmarklet: ' + (b.title || '');
    el.appendChild(bmIcon(b));
    var s = document.createElement('span');
    s.textContent = b.title || hostOf(b.url);
    el.appendChild(s);
    el.appendChild(removeX('Remove bookmark', onRemove));
    el.addEventListener('click', function () { openBookmark(b); });
    return el;
  }
  function folderChip(f, onRemove) {
    var el = document.createElement('div');
    el.className = 'bm fold';
    var n = countLinks(f.items);
    el.title = f.title + ' - ' + n + ' bookmark' + (n === 1 ? '' : 's');
    var ic = document.createElement('span');
    ic.textContent = '📁';
    el.appendChild(ic);
    var s = document.createElement('span');
    s.textContent = f.title;
    el.appendChild(s);
    var car = document.createElement('span');
    car.className = 'car';
    car.textContent = '▾';
    el.appendChild(car);
    el.appendChild(removeX('Remove folder', function () {
      if (confirm('Remove the folder "' + f.title + '" and its ' + n + ' bookmark' + (n === 1 ? '' : 's') + '?')) onRemove();
    }));
    el.addEventListener('click', function () { toggleMenu(el, f); });
    return el;
  }

  /* A folder's menu lives on <body>: the bar scrolls sideways and would clip
     it. Subfolders open in place, with a row back up. */
  var menuEl = null, menuFor = null;
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    menuFor = null;
  }
  function toggleMenu(chip, folder) {
    if (menuFor === chip) { closeMenu(); return; }
    closeMenu();
    menuFor = chip;
    menuEl = document.createElement('div');
    menuEl.id = 'bm-menu';
    document.body.appendChild(menuEl);
    fillMenu([folder]);
    var r = chip.getBoundingClientRect();
    menuEl.style.top = Math.round(r.bottom + 4) + 'px';
    menuEl.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 8))) + 'px';
  }
  function menuRow(icon, title, tail) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'bm-mi';
    if (icon) row.appendChild(icon);
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = title;
    row.appendChild(t);
    if (tail) {
      var g = document.createElement('span');
      g.className = 'go';
      g.textContent = tail;
      row.appendChild(g);
    }
    return row;
  }
  /* trail is every folder opened so far; the last one is the one shown. */
  function fillMenu(trail) {
    var f = trail[trail.length - 1];
    menuEl.textContent = '';
    if (trail.length > 1) {
      var up = menuRow(null, '← ' + trail[trail.length - 2].title);
      up.addEventListener('click', function () { fillMenu(trail.slice(0, -1)); });
      menuEl.appendChild(up);
    }
    var head = document.createElement('div');
    head.className = 'bm-mhead';
    head.textContent = f.title;
    menuEl.appendChild(head);
    if (!f.items.length) {
      var e = document.createElement('div');
      e.className = 'bm-mempty';
      e.textContent = 'Empty folder';
      menuEl.appendChild(e);
    }
    f.items.forEach(function (b) {
      var row;
      if (isFolder(b)) {
        var ic = document.createElement('span');
        ic.textContent = '📁';
        row = menuRow(ic, b.title, '›');
        row.addEventListener('click', function () { fillMenu(trail.concat([b])); });
      } else {
        row = menuRow(bmIcon(b), b.title || hostOf(b.url));
        row.title = isBookmarklet(b.url) ? 'Run bookmarklet' : b.url;
        row.addEventListener('click', function () { closeMenu(); openBookmark(b); });
      }
      menuEl.appendChild(row);
    });
  }
  document.addEventListener('mousedown', function (ev) {
    if (!menuEl) return;
    if (menuEl.contains(ev.target) || (menuFor && menuFor.contains(ev.target))) return;
    closeMenu();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenu(); });
  /* A click into the page frame never reaches this document, but it does take
     focus away from it. */
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  function renderBookmarks() {
    closeMenu();
    bmEl.textContent = '';
    var list = bookmarks();
    /* Pinned bookmarklets sit at the front of the bar and run on click. */
    var pinned = window.XBT && XBT.barItems ? XBT.barItems(bmEl) : 0;
    if (!list.length) {
      if (!pinned) {
        var p = document.createElement('span');
        p.id = 'bm-empty';
        p.textContent = 'No bookmarks yet - press the star on a page, or';
        bmEl.appendChild(p);
      }
      bmEl.appendChild(importChip());
      return;
    }
    if (pinned) {
      var sep = document.createElement('span');
      sep.className = 'bm-sep';
      bmEl.appendChild(sep);
    }
    list.forEach(function (b, i) {
      var remove = function () {
        var l = bookmarks(); l.splice(i, 1); jset(BM, l); renderBookmarks(); syncStar();
      };
      bmEl.appendChild(isFolder(b) ? folderChip(b, remove) : linkChip(b, remove));
    });
    bmEl.appendChild(importChip());
  }

  starEl.addEventListener('click', function () {
    var t = activeTab();
    if (!t || !t.url) return;
    var l = bookmarks();
    if (findUrl(l, t.url)) l = dropUrl(l, t.url);
    else l.push({ url: t.url, title: t.title || hostOf(t.url) });
    jset(BM, l);
    renderBookmarks();
    syncStar();
  });

  /* ---------- importing a bookmarks file ---------- */
  /* Takes the .html file every browser exports its bookmarks as (Chrome, Edge,
     Firefox and Safari all write the old Netscape format), or any page full of
     links. That browser's own bookmarks bar lands on this bar; every other
     folder becomes a folder chip, so a few hundred bookmarks do not turn into
     one endless row. */
  var TOOLBAR = /^(bookmarks bar|bookmarks toolbar|favorites bar|favourites bar)$/i;
  function usableUrl(u) { return /^(https?:|javascript:)/i.test(u || ''); }
  function linkTitle(a, href) {
    var t = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return t || (isBookmarklet(href) ? 'Bookmarklet' : hostOf(href));
  }
  function readDl(dl) {
    var out = [];
    var kids = dl.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.tagName === 'DL' || k.tagName === 'P') { out = out.concat(readDl(k)); continue; }
      if (k.tagName !== 'DT') continue;
      var h3 = null, a = null, sub = null;
      for (var j = 0; j < k.children.length; j++) {
        var c = k.children[j];
        if (c.tagName === 'H3' && !h3) h3 = c;
        else if (c.tagName === 'A' && !a) a = c;
        else if (c.tagName === 'DL' && !sub) sub = c;
      }
      if (h3) {
        /* Some exporters close the <DT> before the folder's <DL>. */
        if (!sub && k.nextElementSibling && k.nextElementSibling.tagName === 'DL') { sub = k.nextElementSibling; i++; }
        var folder = { title: (h3.textContent || '').trim() || 'Folder', items: sub ? readDl(sub) : [] };
        if (h3.getAttribute('personal_toolbar_folder') === 'true' || TOOLBAR.test(folder.title)) folder.bar = true;
        out.push(folder);
      } else if (a) {
        var href = (a.getAttribute('href') || '').trim();
        if (usableUrl(href)) out.push({ url: href, title: linkTitle(a, href) });
      }
    }
    return out;
  }
  function prune(list) {
    return list.filter(function (b) {
      if (!isFolder(b)) return true;
      b.items = prune(b.items);
      return b.items.length > 0;
    });
  }
  function parseBookmarkFile(text) {
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var label = ((doc.querySelector('title') || {}).textContent || '').trim();
    if (!label || /^bookmarks?$/i.test(label)) label = 'Imported bookmarks';
    var bar = [], folders = [], loose = [];
    var dl = doc.querySelector('dl');
    if (dl) {
      prune(readDl(dl)).forEach(function (b) {
        if (isFolder(b) && b.bar) bar = bar.concat(b.items);
        else if (isFolder(b)) folders.push(b);
        else loose.push(b);
      });
    } else {
      var seen = {};
      Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
        var href = (a.getAttribute('href') || '').trim();
        if (!usableUrl(href) || seen[href]) return;
        seen[href] = true;
        loose.push({ url: href, title: linkTitle(a, href) });
      });
    }
    /* A short list of links goes straight on the bar; a long one in a folder. */
    if (loose.length) {
      if (loose.length <= 12 && !bar.length && !folders.length) bar = loose;
      else folders.push({ title: bar.length ? 'More bookmarks' : label, items: loose });
    }
    return { bar: bar, folders: folders };
  }
  function allUrls(list, into) {
    list.forEach(function (b) { if (isFolder(b)) allUrls(b.items, into); else into[b.url] = true; });
    return into;
  }
  /* Adds what is new. A folder with the same name as one already here gets
     merged into it instead of appearing twice. */
  function mergeInto(list, items, seen) {
    var added = 0;
    items.forEach(function (b) {
      if (isFolder(b)) {
        var same = null;
        for (var i = 0; i < list.length; i++) if (isFolder(list[i]) && list[i].title === b.title) same = list[i];
        if (!same) { same = { title: b.title, items: [] }; list.push(same); }
        added += mergeInto(same.items, b.items, seen);
      } else if (!seen[b.url]) {
        seen[b.url] = true;
        list.push({ url: b.url, title: b.title });
        added++;
      }
    });
    return added;
  }
  function bmNote(msg, bad) {
    if (window.XBT && XBT.toast) XBT.toast(msg, bad); else alert(msg);
  }
  function importBookmarkFile(file) {
    if (!/\.html?$/i.test(file.name || '') && file.type !== 'text/html') {
      bmNote('That is not an .html file - export your bookmarks as HTML first', true);
      return;
    }
    if (file.size > 25 * 1024 * 1024) { bmNote('That file is too big to be a bookmarks file', true); return; }
    var r = new FileReader();
    r.onerror = function () { bmNote('Could not read that file', true); };
    r.onload = function () {
      var got;
      try { got = parseBookmarkFile(String(r.result || '')); } catch (e) { bmNote('Could not read bookmarks from that file', true); return; }
      var total = countLinks(got.bar) + countLinks(got.folders);
      if (!total) { bmNote('No bookmarks found in that file', true); return; }
      var l = bookmarks();
      var seen = allUrls(l, {});
      var added = mergeInto(l, got.bar, seen) + mergeInto(l, got.folders, seen);
      l = prune(l);
      if (!added) { bmNote('Nothing new - all ' + total + ' of those are already here'); return; }
      try { localStorage.setItem(BM, JSON.stringify(l)); } catch (e) {
        bmNote('Too many bookmarks to store in this browser', true);
        return;
      }
      renderBookmarks();
      syncStar();
      bmNote('Imported ' + added + ' bookmark' + (added === 1 ? '' : 's') + (added < total ? ' (' + (total - added) + ' already here)' : ''));
    };
    r.readAsText(file);
  }
  var bmFile = document.createElement('input');
  bmFile.type = 'file';
  bmFile.accept = '.html,.htm,text/html';
  bmFile.hidden = true;
  document.body.appendChild(bmFile);
  bmFile.addEventListener('change', function () {
    if (bmFile.files && bmFile.files[0]) importBookmarkFile(bmFile.files[0]);
    bmFile.value = '';
  });
  function pickBookmarkFile() { bmFile.click(); }
  function importChip() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bm imp';
    b.title = 'Import a bookmarks .html file (or drop one on this bar)';
    b.textContent = '+ Import';
    b.addEventListener('click', pickBookmarkFile);
    return b;
  }
  var ntpImport = document.getElementById('ntp-import');
  if (ntpImport) ntpImport.addEventListener('click', pickBookmarkFile);
  /* Dropping the file on the bar works too. */
  bmEl.addEventListener('dragover', function (ev) {
    if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
    ev.preventDefault();
    bmEl.classList.add('drop');
  });
  bmEl.addEventListener('dragleave', function () { bmEl.classList.remove('drop'); });
  bmEl.addEventListener('drop', function (ev) {
    bmEl.classList.remove('drop');
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    ev.preventDefault();
    importBookmarkFile(f);
  });

  /* ---------- toolbar ---------- */
  urlEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var u = toTarget(urlEl.value);
    if (!u) return;
    var t = activeTab();
    if (t) go(t, u); else newTab(u);
  });
  document.getElementById('newtab').addEventListener('click', function () { newTab(null); document.getElementById('ntinput').focus(); });
  document.getElementById('home').addEventListener('click', function () {
    var t = activeTab();
    if (t) showNewTabPage(t);
    document.getElementById('ntinput').focus();
  });

  /* ---------- new tab page ---------- */
  document.getElementById('ntform').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = document.getElementById('ntinput');
    var u = toTarget(inp.value);
    if (!u) return;
    inp.value = '';
    var t = activeTab();
    if (t) go(t, u); else newTab(u);
  });
  var TILES = [
    ['YouTube', 'https://www.youtube.com/'], ['Google', 'https://www.google.com/'],
    ['Discord', 'https://discord.com/app'], ['Reddit', 'https://www.reddit.com/'],
    ['TikTok', 'https://www.tiktok.com/'], ['Twitch', 'https://www.twitch.tv/'],
    ['Monochrome', 'https://monochrome.st/'], ['Movy', 'https://www.movy.sx/'],
    ['GitHub', 'https://github.com/'], ['Wikipedia', 'https://en.wikipedia.org/'],
    ['X', 'https://x.com/'], ['Spotify', 'https://open.spotify.com/']
  ];
  (function buildTiles() {
    var box = document.getElementById('ntp-tiles');
    TILES.forEach(function (tl) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      var ic = document.createElement('span'); ic.className = 'ti';
      var img = document.createElement('img'); img.alt = ''; img.src = favicon(tl[1]);
      img.onerror = function () { ic.textContent = tl[0].charAt(0); };
      ic.appendChild(img);
      var nm = document.createElement('span'); nm.textContent = tl[0];
      b.appendChild(ic); b.appendChild(nm);
      b.addEventListener('click', function () { var t = activeTab(); if (t) go(t, tl[1]); else newTab(tl[1]); });
      box.appendChild(b);
    });
  })();
  (function clock() {
    var el = document.getElementById('ntp-clock');
    function tick() {
      var d = new Date();
      el.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '  ·  ' +
        d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    }
    tick();
    setInterval(tick, 15000);
  })();
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

  /* ---------- shared with tools.js ---------- */
  window.XB = {
    activeTab: activeTab,
    engine: function () { return engine; },
    go: function (u) { var t = activeTab(); if (t) go(t, u); else newTab(u); },
    renderBookmarks: function () { renderBookmarks(); },
    hardReset: function () { return hardReset(); }
  };

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
    try { localStorage.removeItem('xenon-sw-lite-until'); } catch (e) {}
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

  /* When the worker will not start, send what this machine actually got for
     each worker file - status, type, size, first characters, and whether this
     Chrome can parse it - so the cause can be found from the server's side.
     School Chromebooks hit "ServiceWorker script evaluation failed" on
     2026-11-05 while the same files started everywhere else. */
  function swDiag(err, lite) {
    var files = ['/sw.js', '/sw-lite.js', '/uv/uv.bundle.js?v=2', '/uv/uv.config.js?v=2', '/uv/uv.sw.js?v=2', '/scram/scramjet.all.js?v=2'];
    Promise.all(files.map(function (f) {
      return fetch(f, { cache: 'no-store' }).then(function (r) {
        return r.text().then(function (t) {
          var syntax = 'ok';
          try { new Function(t); } catch (e) { syntax = String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 140); }
          return { f: f, status: r.status, type: r.headers.get('content-type') || '', len: t.length, head: t.slice(0, 90), syntax: syntax };
        });
      }, function (e) { return { f: f, fetchError: String(e).slice(0, 140) }; });
    })).then(function (out) {
      return fetch('/api/x/swdiag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ err: String((err && err.message) || err).slice(0, 300), ua: navigator.userAgent, mem: navigator.deviceMemory || 0, lite: lite || '', files: out })
      });
    }).catch(function () {});
  }
  /* Registers the full worker, or the Ultraviolet-only one if the full one
     fails to start (and keeps using that for a day, so the failing attempt
     is not repeated on every visit). */
  var liteWorker = false;
  async function registerWorker() {
    var LITE_KEY = 'xenon-sw-lite-until';
    var useLite = false;
    try { useLite = Number(localStorage.getItem(LITE_KEY) || 0) > Date.now(); } catch (e) {}
    if (!useLite) {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        return;
      } catch (err) {
        say('main engine would not start - trying the light one');
        swDiag(err, 'full failed');
        try { localStorage.setItem(LITE_KEY, String(Date.now() + 864e5)); } catch (e) {}
        try {
          var olds = await navigator.serviceWorker.getRegistrations();
          for (var i = 0; i < olds.length; i++) await olds[i].unregister();
        } catch (e) {}
      }
    }
    try {
      await navigator.serviceWorker.register('/sw-lite.js', { scope: '/' });
      liteWorker = true;
    } catch (err2) {
      swDiag(err2, 'lite failed too');
      try { localStorage.removeItem(LITE_KEY); } catch (e) {}
      throw err2;
    }
  }

  (async function start() {
    try {
      if (!navigator.serviceWorker) throw new Error('needs https or localhost');
      say('registering worker');
      await registerWorker();
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
      var rgn = currentRegion();
      await withTimeout(
        rgn.wisp
          ? conn.setTransport('/epoxy/index.mjs', [{ wisp: rgn.wisp }])
          : conn.setTransport('/baremod/index.mjs', [location.origin + '/bare/']),
        15000,
        'transport did not open in 15s - press Reset and retry'
      );
      paintRegion();

      var qs = new URLSearchParams(location.search);
      var e = qs.get('e');
      if (e === 'scramjet' || e === 'uv') {
        engine = e;
        engineEl.value = e;
        // A game frame (chrome=0) picks its engine for itself; saving it would
        // quietly change the engine the person browses with afterwards.
        if (qs.get('chrome') !== '0') pset('xenon-engine', e);
      }
      /* The light worker only carries Ultraviolet. */
      if (liteWorker && engine === 'scramjet') { engine = 'uv'; engineEl.value = 'uv'; }
      if (engine === 'scramjet') {
        say('starting scramjet');
        try { await initScramjet(); } catch (x) { engine = 'uv'; engineEl.value = 'uv'; }
      }

      boot.hidden = true;
      shell.hidden = false;
      // ?chrome=0 hides the tab strip and toolbar. Used when the portal frames
      // a single site and wants it to look like that site, not like a browser.
      if (qs.get('chrome') === '0') {
        var chromeEl = document.getElementById('chrome');
        if (chromeEl) chromeEl.hidden = true;
      }
      renderBookmarks();

      var first = qs.get('u');
      newTab(first ? toTarget(first) : null);
      if (!first) document.getElementById('ntinput').focus();
    } catch (err) {
      bootFailed(String(err.message || err));
    }
  })();
})();
