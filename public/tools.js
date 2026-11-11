/* Xenon browser tools: the bookmarklet library and dev tools drawer.
 *
 * Everything here acts on the active tab's frame. The frames are same-origin
 * with this shell (they are /scramjet/ or /service/ URLs on this host), so we
 * can reach into their document and window directly.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var API = '/api/bookmarklets';

  function pref(k, d) { try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {} return d; }
  function pset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); if (v) return v; } catch (e) {} return d; }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* Who may delete a post later. Same scheme as chat: a random token kept in
     this browser, and the server stores only its hash. */
  var token = pref('xenon-bml-token', '');
  if (!token) {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    token = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    pset('xenon-bml-token', token);
  }
  var adminKey = pref('xenon-bml-admin', '');
  var isAdmin = false;

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = bad ? 'err' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 4200 : 2400);
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('error ' + r.status));
        return j;
      });
    });
  }

  /* ---------- reaching the page ---------- */
  function page() {
    var t = window.XB && XB.activeTab();
    if (!t || !t.url || !t.frame) return null;
    try {
      var w = t.frame.contentWindow, d = t.frame.contentDocument;
      if (!w || !d || !d.documentElement) return null;
      return { tab: t, win: w, doc: d };
    } catch (e) { return null; }
  }
  function needPage() {
    var p = page();
    if (!p) toast('Open a site first, then run this on it', true);
    return p;
  }

  /* Run code inside the page. It goes in as an inline <script>, so the proxy
     engine's own DOM hooks see it like any script the site added itself -
     anything the code loads goes through the proxy too. Errors and the last
     expression's value come back through a global on the page's window. */
  function inject(p, code) {
    var s = p.doc.createElement('script');
    s.textContent = code;
    (p.doc.head || p.doc.documentElement).appendChild(s);
    if (s.parentNode) s.parentNode.removeChild(s);
  }
  /* Code injected this way is not rewritten by the engine, so `location`
     would be the proxy's own address and setting it would leave the proxy.
     Both engines leave their JS rewriter on the page's window; run the code
     through it first so it sees the real site. */
  function rewrite(p, code) {
    try {
      if (typeof p.win.$scramjet$rewrite === 'function') return p.win.$scramjet$rewrite(code);
      if (p.win.__uv && typeof p.win.__uv.rewriteJS === 'function') return p.win.__uv.rewriteJS(code);
    } catch (e) {}
    return code;
  }
  function runCode(code, quiet) {
    var p = needPage();
    if (!p) return { err: 'no page' };
    /* A syntax error would otherwise surface as a vague rewriter failure. */
    try { new Function(code); } catch (e) {
      if (!quiet) toast('Error: ' + e.message, true);
      return { err: e.message };
    }
    var rw = rewrite(p, code);
    var body = 'eval(' + JSON.stringify(rw) + ')';
    /* Scramjet's rewriter hands most code back untouched. Its wrap() still
       maps the real location to the proxied one, so shadow `location` with
       that for the code's scope. */
    if (rw === code && typeof p.win.$scramjet$wrap === 'function') {
      body = '(function(location){return eval(' + JSON.stringify(code) + ')})($scramjet$wrap(location))';
    }
    var wrap = 'try{window.__xnRes={v:' + body + '}}catch(e){window.__xnRes={e:String(e&&e.message||e)}}';
    try { p.win.__xnRes = undefined; } catch (e) {}
    try { inject(p, wrap); } catch (e) {}
    var res;
    try { res = p.win.__xnRes; } catch (e) {}
    if (res === undefined) {
      /* The script tag never ran (some pages block inline scripts). Fall back
         to evaluating it in the page's window directly. */
      try { p.win.eval(wrap); res = p.win.__xnRes; } catch (e) { res = { e: String(e && e.message || e) }; }
    }
    if (!res) res = { v: undefined };
    if (res.e && !quiet) toast('Error: ' + res.e, true);
    return { err: res.e || null, value: res.v };
  }

  /* ---------- drawer ---------- */
  var drawer = $('drawer');
  var paneNow = 'bml';
  function openDrawer(pane) {
    paneNow = pane || paneNow;
    drawer.hidden = false;
    var tabs = drawer.querySelectorAll('.dr-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-pane') === paneNow);
    $('pane-bml').classList.toggle('on', paneNow === 'bml');
    $('pane-dev').classList.toggle('on', paneNow === 'dev');
    $('btn-bml').classList.toggle('on', paneNow === 'bml');
    $('btn-dev').classList.toggle('on', paneNow === 'dev');
    if (paneNow === 'bml' && !loaded) loadList();
    if (paneNow === 'dev') paintSite();
  }
  function closeDrawer() {
    drawer.hidden = true;
    $('btn-bml').classList.remove('on');
    $('btn-dev').classList.remove('on');
  }
  function toggleDrawer(pane) {
    if (!drawer.hidden && paneNow === pane) closeDrawer(); else openDrawer(pane);
  }
  $('btn-bml').addEventListener('click', function () { toggleDrawer('bml'); });
  $('btn-dev').addEventListener('click', function () { toggleDrawer('dev'); });
  $('dr-close').addEventListener('click', closeDrawer);
  Array.prototype.forEach.call(drawer.querySelectorAll('.dr-tab'), function (b) {
    b.addEventListener('click', function () { openDrawer(b.getAttribute('data-pane')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.ntp-chip[data-open]'), function (b) {
    b.addEventListener('click', function () { openDrawer(b.getAttribute('data-open')); });
  });

  /* ---------- bookmarklet library ---------- */
  var items = [];
  var loaded = false;
  var filter = 'all';
  var openCode = {};

  function pins() { return jget('xenon-bml-pins', []); }
  function isPinned(id) { return pins().some(function (p) { return String(p.id) === String(id); }); }
  function togglePin(b) {
    var l = pins();
    var i = -1;
    l.forEach(function (p, k) { if (String(p.id) === String(b.id)) i = k; });
    if (i >= 0) l.splice(i, 1);
    /* The code is stored with the pin, so a pinned bookmarklet still works
       when the server is down or the post is later deleted. */
    else l.push({ id: b.id, name: b.name, code: b.code });
    jset('xenon-bml-pins', l);
    if (window.XB) XB.renderBookmarks();
    renderList();
    toast(i >= 0 ? 'Unpinned' : 'Pinned to the bookmarks bar');
  }

  function runBookmarklet(b) {
    var r = runCode(b.code);
    if (!r.err && r.err !== 'no page') {
      toast('Ran ' + b.name);
      post('/use', { id: String(b.id) }).catch(function () {});
    }
  }

  function loadList() {
    $('bml-list').innerHTML = '<p class="empty">Loading...</p>';
    fetch(API + '/list?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { items = j.items || []; loaded = true; renderList(); })
      .catch(function () {
        /* Server unreachable: pinned ones still work from local storage. */
        items = pins().map(function (p) { return { id: p.id, name: p.name, code: p.code, desc: 'Saved in this browser', author: '' }; });
        renderList();
        var e = document.createElement('p');
        e.className = 'empty';
        e.textContent = 'Could not reach the library. Showing your pinned ones.';
        $('bml-list').insertBefore(e, $('bml-list').firstChild);
      });
  }

  function visible() {
    var q = $('bml-q').value.trim().toLowerCase();
    var l = items.filter(function (b) {
      if (filter === 'official' && !b.official) return false;
      if (filter === 'mine' && !b.mine) return false;
      if (filter === 'saved' && !isPinned(b.id)) return false;
      if (!q) return true;
      return (b.name + ' ' + (b.desc || '') + ' ' + (b.author || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (filter === 'new') l.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    else if (filter === 'popular') l.sort(function (a, b) { return (b.uses || 0) - (a.uses || 0); });
    else l.sort(function (a, b) {
      if (!!b.official !== !!a.official) return b.official ? 1 : -1;
      return (b.uses || 0) - (a.uses || 0);
    });
    return l;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderList() {
    var box = $('bml-list');
    box.textContent = '';
    var l = visible();
    if (!l.length) {
      box.appendChild(el('p', 'empty', filter === 'mine' ? 'You have not posted any yet. Press + Post.'
        : filter === 'saved' ? 'Nothing pinned. Press the star on a bookmarklet to pin it to the bar.'
        : 'No bookmarklets match.'));
      return;
    }
    l.forEach(function (b) {
      var c = el('div', 'bk-card' + (b.official ? ' official' : ''));
      var top = el('div', 'bk-row');
      top.appendChild(el('span', 'bk-name', b.name));
      if (b.official) top.appendChild(el('span', 'badge off', 'OFFICIAL'));
      if (b.mine) top.appendChild(el('span', 'badge me', 'YOURS'));
      c.appendChild(top);
      if (b.desc) c.appendChild(el('p', 'bk-desc', b.desc));
      var row = el('div', 'bk-row');
      var meta = (b.author ? 'by ' + b.author : '') + (b.uses ? (b.author ? '  ·  ' : '') + b.uses + (b.uses === 1 ? ' run' : ' runs') : '');
      row.appendChild(el('span', 'bk-meta', meta));
      var acts = el('div', 'bk-acts');
      var run = el('button', 'btn-prim', 'Run');
      run.type = 'button';
      run.addEventListener('click', function () { runBookmarklet(b); });
      var pin = el('button', 'btn bk-pin' + (isPinned(b.id) ? ' on' : ''), isPinned(b.id) ? '★' : '☆');
      pin.type = 'button';
      pin.title = 'Pin to the bookmarks bar';
      pin.addEventListener('click', function () { togglePin(b); });
      var code = el('button', 'btn', '</>');
      code.type = 'button';
      code.title = 'Show the code';
      code.addEventListener('click', function () { openCode[b.id] = !openCode[b.id]; renderList(); });
      acts.appendChild(run); acts.appendChild(pin); acts.appendChild(code);
      if (!b.builtin && (b.mine || isAdmin)) {
        var del = el('button', 'btn danger', '\u{1F5D1}');
        del.type = 'button';
        del.title = 'Delete';
        del.addEventListener('click', function () {
          if (!confirm('Delete "' + b.name + '" from the library?')) return;
          post('/delete', { id: b.id, token: token, admin: adminKey })
            .then(function () { toast('Deleted'); loadList(); })
            .catch(function (e) { toast(e.message, true); });
        });
        acts.appendChild(del);
      }
      row.appendChild(acts);
      c.appendChild(row);
      if (openCode[b.id]) c.appendChild(el('pre', 'bk-code', b.code));
      box.appendChild(c);
    });
  }

  $('bml-q').addEventListener('input', renderList);
  Array.prototype.forEach.call(document.querySelectorAll('#bml-filters .chip'), function (b) {
    b.addEventListener('click', function () {
      filter = b.getAttribute('data-f');
      Array.prototype.forEach.call(document.querySelectorAll('#bml-filters .chip'), function (x) { x.classList.toggle('on', x === b); });
      renderList();
    });
  });

  /* Posting */
  var form = $('bml-form');
  function openForm(code) {
    form.hidden = false;
    $('bf-err').textContent = '';
    if (code) $('bf-code').value = code;
    $('bf-author').value = $('bf-author').value || pref('xenon-bml-author', '');
    $('bf-name').focus();
  }
  $('bml-new').addEventListener('click', function () { if (form.hidden) openForm(); else form.hidden = true; });
  $('bf-cancel').addEventListener('click', function () { form.hidden = true; });
  $('bf-test').addEventListener('click', function () {
    var code = $('bf-code').value.trim().replace(/^javascript:/i, '');
    if (/%[0-9a-f]{2}/i.test(code)) { try { code = decodeURIComponent(code); } catch (e) {} }
    if (!code) return;
    var r = runCode(code);
    if (!r.err) toast('Ran it on this page');
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('bf-post');
    btn.disabled = true;
    $('bf-err').textContent = '';
    var author = $('bf-author').value.trim();
    pset('xenon-bml-author', author);
    post('/add', { name: $('bf-name').value, desc: $('bf-desc').value, code: $('bf-code').value, author: author, token: token, admin: adminKey })
      .then(function () {
        form.reset();
        form.hidden = true;
        toast('Posted to the library');
        filter = 'new';
        Array.prototype.forEach.call(document.querySelectorAll('#bml-filters .chip'), function (x) { x.classList.toggle('on', x.getAttribute('data-f') === 'new'); });
        loadList();
      })
      .catch(function (err) { $('bf-err').textContent = err.message; })
      .then(function () { btn.disabled = false; });
  });

  /* Owner key */
  function checkAdmin() {
    if (!adminKey) { isAdmin = false; $('bml-admin-state').textContent = ''; return; }
    post('/admin', { admin: adminKey }).then(function (j) {
      isAdmin = !!j.ok;
      $('bml-admin-state').textContent = isAdmin ? 'Owner mode on - your posts are Official.' : 'That key is wrong.';
      if (loaded) renderList();
    }).catch(function () {});
  }
  $('bml-admin').value = adminKey;
  $('bml-admin-save').addEventListener('click', function () {
    adminKey = $('bml-admin').value.trim();
    pset('xenon-bml-admin', adminKey);
    checkAdmin();
  });
  checkAdmin();

  /* Pinned ones in the bookmarks bar. Called by browser.js while it draws the bar. */
  function barItems(bar) {
    var l = pins();
    l.forEach(function (b) {
      var c = el('button', 'bm bk');
      c.type = 'button';
      c.title = 'Run bookmarklet: ' + b.name;
      c.textContent = '⚡ ' + b.name;
      c.addEventListener('click', function () { runBookmarklet(b); });
      bar.appendChild(c);
    });
    return l.length;
  }

  /* ---------- dev tools ---------- */
  var erudaSrc = null;
  function getEruda() {
    if (erudaSrc) return Promise.resolve(erudaSrc);
    return fetch('/eruda/eruda.js').then(function (r) {
      if (!r.ok) throw new Error('could not load devtools');
      return r.text();
    }).then(function (t) { erudaSrc = t; return t; });
  }
  function showEruda(p) {
    var w = p.win;
    if (!w.eruda) {
      try { inject(p, erudaSrc); } catch (e) {}
      if (!w.eruda) { try { w.eval(erudaSrc); } catch (e) {} }
    }
    if (!w.eruda) { toast('This page would not take the devtools', true); return false; }
    if (!w.__xnErudaInit) {
      w.eruda.init({ useShadowDom: true, autoScale: true });
      w.__xnErudaInit = true;
      /* Eruda's own defaults (light-ish "System preference", 80% tall) are not
         overridable through init. Its settings are stored per site under
         Ultraviolet, so check the values rather than a flag of our own:
         anything still on the defaults gets ours. */
      try {
        var dt = w.eruda._devTools;
        if (dt.config.get('theme') === 'System preference') dt.config.set('theme', 'Dark');
        if (dt.config.get('displaySize') === 80) dt.config.set('displaySize', 55);
        /* config.set stores the theme but does not repaint until next init. */
        dt._setTheme(dt.config.get('theme'));
        dt._setDisplaySize(dt.config.get('displaySize'));
      } catch (e) {}
    }
    w.eruda.show();
    return true;
  }
  function toggleEruda() {
    var p = needPage();
    if (!p) return;
    var w = p.win;
    if (w.__xnErudaInit && p.tab.devOpen) {
      w.eruda.hide();
      p.tab.devOpen = false;
      return;
    }
    getEruda().then(function () {
      if (showEruda(p)) { p.tab.devOpen = true; closeDrawer(); }
    }).catch(function (e) { toast(e.message, true); });
  }

  var OUTLINE = "(function(){var s=document.getElementById('xn-outline');if(s){s.remove();return false;}s=document.createElement('style');s.id='xn-outline';s.textContent='*{outline:1px solid rgba(255,80,120,.55)!important;outline-offset:-1px}';document.head.appendChild(s);return true;})()";
  var PICK = "(function(){if(window.__xnPick)return;window.__xnPick=1;var box=document.createElement('div');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff5078;background:rgba(255,80,120,.15);border-radius:3px;transition:all .05s';document.documentElement.appendChild(box);var cur=null;function mv(e){cur=e.target;var r=cur.getBoundingClientRect();box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';}function ck(e){e.preventDefault();e.stopPropagation();if(cur&&cur!==document.documentElement&&cur!==document.body)cur.remove();}function stop(e){if(!e||e.key==='Escape'){document.removeEventListener('mousemove',mv,true);document.removeEventListener('click',ck,true);document.removeEventListener('keydown',stop,true);box.remove();window.__xnPick=0;}}document.addEventListener('mousemove',mv,true);document.addEventListener('click',ck,true);document.addEventListener('keydown',stop,true);})()";

  function paintEditState() {
    var p = page();
    var on = false, ol = false;
    try { on = !!(p && p.doc.designMode === 'on'); ol = !!(p && p.doc.getElementById('xn-outline')); } catch (e) {}
    var a = $('dev-edit-state'), b = $('dev-outline-state');
    a.textContent = on ? 'on' : 'off'; a.className = on ? 'on' : '';
    b.textContent = ol ? 'on' : 'off'; b.className = ol ? 'on' : '';
  }

  function paintSite() {
    var box = $('dev-site');
    box.textContent = '';
    var p = page();
    if (!p) { box.textContent = 'No site open in this tab. Open one, and these tools act on it.'; paintEditState(); return; }
    function line(k, v) { var d = el('div'); d.appendChild(el('b', '', k + ' ')); d.appendChild(document.createTextNode(v)); box.appendChild(d); }
    var d = p.doc;
    line('Site', p.tab.url);
    line('Title', d.title || '(none)');
    var n = function (s) { try { return d.querySelectorAll(s).length; } catch (e) { return 0; } };
    line('Page', n('script') + ' scripts  ·  ' + n('iframe') + ' frames  ·  ' + n('img') + ' images  ·  ' + n('a[href]') + ' links');
    line('Engine', window.XB ? (XB.engine() === 'uv' ? 'Ultraviolet' : 'Scramjet') : '');
    paintEditState();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.dev-card'), function (b) {
    b.addEventListener('click', function () {
      var what = b.getAttribute('data-dev');
      if (what === 'reset') {
        if (!confirm('Reset the proxy? This clears its worker and caches and reloads. Your bookmarks stay.')) return;
        toast('Resetting...');
        XB.hardReset().then(function () { location.reload(); });
        return;
      }
      if (what === 'eruda') { toggleEruda(); return; }
      var p = needPage();
      if (!p) return;
      if (what === 'edit') {
        p.doc.designMode = p.doc.designMode === 'on' ? 'off' : 'on';
        toast(p.doc.designMode === 'on' ? 'Edit mode on - click anywhere and type' : 'Edit mode off');
      } else if (what === 'outline') {
        runCode(OUTLINE, true);
      } else if (what === 'pick') {
        runCode(PICK, true);
        closeDrawer();
        toast('Click things to delete them. Esc to stop.');
        try { p.tab.frame.focus(); } catch (e) {}
      } else if (what === 'source') {
        var html = '';
        try { html = '<!DOCTYPE html>\n' + p.doc.documentElement.outerHTML; } catch (e) { html = String(e); }
        $('md-title').textContent = 'Source of ' + p.tab.url;
        $('md-body').textContent = html;
        $('modal').hidden = false;
      }
      paintEditState();
    });
  });

  function fmt(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return String(v).slice(0, 400);
    if (v && v.nodeType === 1) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
    try { var s = JSON.stringify(v, null, 2); if (s !== undefined) return s.length > 6000 ? s.slice(0, 6000) + '\n...' : s; } catch (e) {}
    return String(v);
  }
  function runConsole() {
    var code = $('dev-js').value;
    if (!code.trim()) return;
    var r = runCode(code, true);
    var out = $('dev-out');
    if (r.err === 'no page') return;
    out.className = r.err ? 'err' : '';
    out.textContent = r.err ? r.err : fmt(r.value);
    paintSite();
  }
  $('dev-run').addEventListener('click', runConsole);
  $('dev-js').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runConsole(); }
  });
  $('dev-post').addEventListener('click', function () {
    var code = $('dev-js').value.trim();
    openDrawer('bml');
    openForm(code);
  });

  /* Modal */
  function closeModal() { $('modal').hidden = true; }
  $('md-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  $('md-copy').addEventListener('click', function () {
    var t = $('md-body').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Copied'); })
      .catch(function () { toast('Could not copy', true); });
  });

  /* ---------- keys ----------
     Bound on this shell and on every page loaded in a tab, because once you
     click into a site its frame has the keyboard, not us. */
  function onKey(e) {
    var k = (e.key || '').toLowerCase();
    var meta = e.ctrlKey || e.metaKey;
    if (e.key === 'F12' || (meta && e.shiftKey && k === 'i')) { e.preventDefault(); toggleEruda(); return; }
    if (meta && e.shiftKey && k === 'b') { e.preventDefault(); toggleDrawer('bml'); return; }
    if (meta && e.shiftKey && k === 'k') { e.preventDefault(); openDrawer('dev'); $('dev-js').focus(); return; }
    if (e.key === 'Escape' && e.target && e.target.ownerDocument === document) {
      if (!$('modal').hidden) closeModal();
      else if (!drawer.hidden) closeDrawer();
    }
  }
  document.addEventListener('keydown', onKey);

  /* Called by browser.js every time a tab's frame finishes loading. */
  function onFrameLoad(tab) {
    var w;
    try { w = tab.frame.contentWindow; if (!w || w.__xnKeys) return; w.__xnKeys = 1; w.addEventListener('keydown', onKey, true); } catch (e) { return; }
    /* Devtools were open on this tab: bring them back on the new page. */
    if (tab.devOpen) {
      var act = window.XB && XB.activeTab();
      getEruda().then(function () {
        var p = page();
        if (p && act === tab) showEruda(p);
      }).catch(function () {});
    }
    if (!drawer.hidden && paneNow === 'dev') paintSite();
  }

  window.XBT = { barItems: barItems, onFrameLoad: onFrameLoad, run: runCode, toast: toast };
  /* browser.js drew the bookmarks bar before this file loaded. */
  if (window.XB) XB.renderBookmarks();
})();
