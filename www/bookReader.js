/*! bookReader.js — realistic book reading interface (EPUB / HTML / plain text)
 *
 *  Usage:
 *    <link rel="stylesheet" href="reader.css">
 *    <script src="lib/jszip.min.js"></script>      <!-- only needed for EPUB -->
 *    <script src="bookReader.js"></script>
 *
 *    const reader = new BookReader('#host', { storageKey: 'turnleaf' });
 *    reader.open(epubFileOrArrayBuffer);             // EPUB (Blob / File / ArrayBuffer)
 *    reader.open('<h1>Title</h1><p>Hello…</p>');     // HTML string
 *    reader.open('Plain text\n\nwith paragraphs');   // text string
 *    reader.on('relocate', e => console.log(e.page, e.total));
 *
 *  Layout   : wide screens → two-page spread, phones → single paper page.
 *  Paging   : CSS multi-column pagination; page turns use CSS 3D rotateY().
 *  Gestures : tap right 20% = next, left 20% = previous, centre 60% = toolbars,
 *             swipe = drag the page, pinch = zoom a page, drag = pan, double-tap = reset.
 */
(function (global, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.BookReader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */
  var DEFAULTS = {
    mode: 'auto',               // 'auto' | 'single' | 'spread'
    spreadMinWidth: 900,        // px — auto mode uses a spread at/above this width (landscape)
    fontSize: 18,               // px
    fontFamily: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif',
    lineHeight: 1.6,
    theme: 'paper',             // 'paper' | 'sepia' | 'night'
    maxZoom: 4,
    flipDuration: 650,          // ms
    tapZone: 0.2,               // fraction of width for prev / next zones
    toolbars: true,             // build the built-in toolbars
    toolbarsVisible: true,      // initial state (auto-hides on first page turn)
    maxBlocksPerSection: 600,   // very long chapters are split into chunks
    storageKey: null,           // string → remember page, chapter + font/theme in localStorage
    JSZip: null                 // pass JSZip if it isn't a global
  };
  var THEMES = ['paper', 'sepia', 'night'];

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function btn(label, html, cls) {
    var b = el('button', cls || 'br-btn');
    b.type = 'button'; b.setAttribute('aria-label', label); b.innerHTML = html;
    return b;
  }
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function tick() { // next frame, but never stalls in a background tab
    return new Promise(function (r) {
      var done = false, f = function () { if (!done) { done = true; r(); } };
      requestAnimationFrame(f); setTimeout(f, 50);
    });
  }
  function imagesReady(node, timeout) {
    var imgs = Array.prototype.filter.call(node.querySelectorAll('img'), function (i) { return !i.complete; });
    if (!imgs.length) return Promise.resolve();
    return Promise.race([
      Promise.all(imgs.map(function (i) {
        return new Promise(function (r) {
          i.addEventListener('load', r, { once: true });
          i.addEventListener('error', r, { once: true });
        });
      })),
      sleep(timeout || 2500)
    ]);
  }
  function dirname(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function joinPath(base, rel) {
    var parts = (base ? base + '/' + rel : rel).split('/'), out = [];
    parts.forEach(function (s) {
      if (s === '..') out.pop(); else if (s && s !== '.') out.push(s);
    });
    return out.join('/');
  }
  function mimeOf(p) {
    var e = (p.split('.').pop() || '').toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
             svg: 'image/svg+xml', webp: 'image/webp' }[e] || 'application/octet-stream';
  }
  function parseXML(str) { return new DOMParser().parseFromString(str, 'application/xml'); }

  /* ---------- Sanitising (content may come from untrusted files) ---------- */
  var BAD = 'script,iframe,object,embed,link,meta,style,base,form,input,button,textarea,select,' +
            'audio,video,canvas,noscript,foreignObject';
  function sanitize(root) {
    Array.prototype.forEach.call(root.querySelectorAll(BAD), function (n) { n.remove(); });
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase();
        var link = name === 'href' || name === 'src' || /:href$/.test(name);
        if (name.indexOf('on') === 0 || name === 'style' ||
            (link && /^\s*(javascript:|data:text\/html)/i.test(a.value))) n.removeAttribute(a.name);
      });
    });
  }

  /* ---------- Turning a parsed <body> into sections (= pagination units) ---------- */
  var WRAPPERS = /^(DIV|MAIN|ARTICLE|SECTION|BODY)$/;
  function topLevelNodes(body) {
    var nodes = Array.prototype.slice.call(body.childNodes);
    var sig = function (list) {
      return list.filter(function (n) { return n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()); });
    };
    var cur = sig(nodes);
    while (cur.length === 1 && cur[0].nodeType === 1 && WRAPPERS.test(cur[0].tagName) &&
           cur[0].childNodes.length > 1) {
      cur = sig(Array.prototype.slice.call(cur[0].childNodes));
    }
    return cur.map(function (n) {
      if (n.nodeType === 3) { var p = document.createElement('p'); p.textContent = n.textContent.trim(); return p; }
      return n;
    });
  }
  function firstHeading(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (/^H[1-3]$/.test(n.tagName)) return n.textContent.trim();
      var h = n.querySelector && n.querySelector('h1,h2,h3');
      if (h) return h.textContent.trim();
    }
    return '';
  }
  function makeSections(nodes, opt) {
    var groups = [], cur = [], brk = null, max = opt.max;
    if (opt.splitHeadings) {
      brk = nodes.some(function (n) { return n.tagName === 'H1'; }) ? 'H1'
          : (nodes.some(function (n) { return n.tagName === 'H2'; }) ? 'H2' : null);
    }
    nodes.forEach(function (n) {
      if (brk && n.tagName === brk && cur.length) { groups.push(cur); cur = []; }
      cur.push(n);
      if (cur.length >= max) { groups.push(cur); cur = []; }
    });
    if (cur.length) groups.push(cur);
    return groups.map(function (g, i) {
      var frag = document.createDocumentFragment();
      g.forEach(function (n) { frag.appendChild(document.importNode(n, true)); });
      var t = firstHeading(g);
      return { title: t || (i === 0 ? (opt.title || '') : ''), frag: frag, count: 1, start: 0 };
    });
  }
  function parseHTMLString(html, meta, max) {
    var d = new DOMParser().parseFromString(html, 'text/html');
    sanitize(d.body);
    var title = meta.title || (d.title || '').trim();
    var sections = makeSections(topLevelNodes(d.body), { splitHeadings: true, max: max, title: title });
    return { title: title || (sections[0] && sections[0].title) || 'Untitled', author: meta.author || '', sections: sections };
  }
  function parseText(text, meta, max) {
    var paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    var html = paras.map(function (p) { return '<p>' + esc(p.replace(/\n/g, ' ')) + '</p>'; }).join('');
    return parseHTMLString(html, meta, max);
  }
  function isZip(buf) { var u = new Uint8Array(buf, 0, 2); return u[0] === 0x50 && u[1] === 0x4B; }
  function toArrayBuffer(src) {
    if (src instanceof ArrayBuffer) return Promise.resolve(src);
    if (ArrayBuffer.isView(src)) return Promise.resolve(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    if (src && src.arrayBuffer) return src.arrayBuffer();
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
      return new Promise(function (res, rej) {
        var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(src);
      });
    }
    if (src && src.url) return fetch(src.url).then(function (r) { return r.arrayBuffer(); });
    return Promise.reject(new Error('Unsupported book source'));
  }

  /* ================================================================== */
  /* BookReader                                                         */
  /* ================================================================== */
  function BookReader(container, options) {
    this.host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.host) throw new Error('BookReader: container not found');
    this.o = Object.assign({}, DEFAULTS, options || {});

    this._ev = {}; this._off = [];
    this._ptrs = new Map(); this._g = null; this._pinch = null;
    this._flip = null; this._queued = 0; this._lastTap = null; this._tapTimer = 0; this._wheelT = 0;
    this._zoom = { slot: null, s: 1, tx: 0, ty: 0 };
    this._token = 0; this._layoutTok = 0; this._urls = [];
    this.doc = null; this.sections = []; this.total = 0; this.pos = 0;
    this.g = null; this.slots = {};
    this._autoHide = !!(this.o.toolbars && this.o.toolbarsVisible);
    this._reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    var prefs = this._loadPrefs();
    this.fontSize = prefs.fontSize || this.o.fontSize;
    this.theme = THEMES.indexOf(prefs.theme) >= 0 ? prefs.theme : this.o.theme;

    this._build();
    this._bind();
  }
  var P = BookReader.prototype;

  /* ---------------------------- events ------------------------------- */
  P.on = function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); return this; };
  P.off = function (t, fn) {
    this._ev[t] = (this._ev[t] || []).filter(function (f) { return f !== fn; }); return this;
  };
  P._emit = function (t, d) {
    (this._ev[t] || []).slice().forEach(function (fn) { try { fn(d); } catch (e) { console.error(e); } });
    try { this.root.dispatchEvent(new CustomEvent('bookreader:' + t, { detail: d })); } catch (e) { /* old WebView */ }
  };

  /* ----------------------------- DOM --------------------------------- */
  P._build = function () {
    var root = this.root = el('div', 'br-root');
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Book reader');
    root.dataset.theme = this.theme;
    root.style.setProperty('--br-font', this.o.fontFamily);
    root.style.setProperty('--br-lh', String(this.o.lineHeight));
    root.style.setProperty('--br-fs', this.fontSize + 'px');

    this.stage = el('div', 'br-stage');
    this.book = el('div', 'br-book');
    this.stage.appendChild(this.book);
    this.live = el('div', 'br-live'); this.live.setAttribute('aria-live', 'polite');
    this.loading = el('div', 'br-loading'); this.loading.hidden = true;
    root.appendChild(this.stage);
    if (this.o.toolbars) { this._buildBars(); this._buildToc(); }
    root.appendChild(this.live);
    root.appendChild(this.loading);
    if (!(this.o.toolbars && this.o.toolbarsVisible)) root.classList.add('br-ui-hidden');
    this.host.appendChild(root);
  };

  P._buildBars = function () {
    var self = this;
    var SV = function (d) {
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
             'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
    };
    var top = el('header', 'br-bar br-top');
    var close = btn('Close book', SV('<path d="M15 5l-7 7 7 7"/>'));
    close.addEventListener('click', function () { self._emit('close'); });
    var titles = el('div', 'br-titles');
    this.elTitle = el('div', 'br-title'); this.elChapter = el('div', 'br-chapter');
    titles.appendChild(this.elTitle); titles.appendChild(this.elChapter);
    var themeBtn = btn('Change page colour', SV('<path d="M12 3a9 9 0 100 18V3z"/><circle cx="12" cy="12" r="9"/>'));
    themeBtn.addEventListener('click', function () {
      self.setTheme(THEMES[(THEMES.indexOf(self.theme) + 1) % THEMES.length]);
    });
    var tocBtn = this.tocBtn = btn('Table of contents', SV('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'));
    tocBtn.setAttribute('aria-haspopup', 'dialog'); tocBtn.setAttribute('aria-expanded', 'false');
    tocBtn.addEventListener('click', function () { self.toggleToc(); });
    top.appendChild(close); top.appendChild(tocBtn); top.appendChild(titles); top.appendChild(themeBtn);

    var bot = el('footer', 'br-bar br-bottom');
    var r1 = el('div', 'br-row');
    var prev = btn('Previous page', SV('<path d="M15 5l-7 7 7 7"/>'));
    var next = btn('Next page', SV('<path d="M9 5l7 7-7 7"/>'));
    prev.addEventListener('click', function () { self.prev(); });
    next.addEventListener('click', function () { self.next(); });
    var sl = this.slider = el('input', 'br-slider');
    sl.type = 'range'; sl.min = 0; sl.max = 0; sl.value = 0; sl.step = 1;
    sl.setAttribute('aria-label', 'Go to page');
    sl.addEventListener('input', function () { self.label.textContent = 'Page ' + (+sl.value + 1) + ' of ' + self.total; });
    sl.addEventListener('change', function () { self.goTo(+sl.value); });
    r1.appendChild(prev); r1.appendChild(sl); r1.appendChild(next);
    var r2 = el('div', 'br-row br-sub');
    var minus = btn('Smaller text', 'A\u2212'), plus = btn('Bigger text', 'A+');
    minus.addEventListener('click', function () { self.setFontSize(self.fontSize - 1); });
    plus.addEventListener('click', function () { self.setFontSize(self.fontSize + 1); });
    this.label = el('div', 'br-label');
    r2.appendChild(minus); r2.appendChild(this.label); r2.appendChild(plus);
    bot.appendChild(r1); bot.appendChild(r2);
    this.root.appendChild(top); this.root.appendChild(bot);
  };

  /* ------------------------ table of contents ------------------------ */
  P._buildToc = function () {
    var self = this;
    var scrim = this.tocScrim = el('div', 'br-toc-scrim');
    scrim.addEventListener('click', function () { self.closeToc(); });
    var d = this.toc = el('aside', 'br-toc');
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Table of contents');
    var head = el('div', 'br-toc-head');
    var h = el('h2', 'br-toc-h'); h.textContent = 'Contents';
    var x = btn('Close contents', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>');
    x.addEventListener('click', function () { self.closeToc(); });
    head.appendChild(h); head.appendChild(x);
    this.tocScroll = el('div', 'br-toc-scroll');
    this.tocList = el('ol', 'br-toc-list');
    this.tocEmpty = el('p', 'br-toc-empty'); this.tocEmpty.textContent = 'This book has no chapters.'; this.tocEmpty.hidden = true;
    this.tocScroll.appendChild(this.tocList); this.tocScroll.appendChild(this.tocEmpty);
    d.appendChild(head); d.appendChild(this.tocScroll);
    this.root.appendChild(scrim); this.root.appendChild(d);
    this._tocItems = []; this._tocCur = null; this._tocOpen = false;
  };
  P._renderToc = function () {
    if (!this.tocList) return;
    var self = this, list = this.tocList;
    list.textContent = ''; this._tocItems = []; this._tocCur = null;
    this.sections.forEach(function (s, i) {
      var title = (s.title || '').replace(/\s+/g, ' ').trim();
      if (!title && i !== 0) return;                    // continuation chunks / untitled files
      var li = el('li'), b = el('button', 'br-toc-item');
      b.type = 'button';
      var name = el('span', 'br-toc-name'); name.textContent = title || 'Beginning';
      var pg = el('span', 'br-toc-page'); pg.textContent = String(s.start + 1);
      b.appendChild(name); b.appendChild(pg);
      b.addEventListener('click', function () { self._tocJump(i); });
      li.appendChild(b); list.appendChild(li);
      self._tocItems.push({ si: i, btn: b });
    });
    this.tocEmpty.hidden = this._tocItems.length > 0;
  };
  P._markToc = function (si) {                          // highlight the chapter being read
    var items = this._tocItems || [], cur = null;
    for (var i = 0; i < items.length; i++) { if (items[i].si <= si) cur = items[i]; else break; }
    if (cur === this._tocCur) return;
    if (this._tocCur) { this._tocCur.btn.classList.remove('br-current'); this._tocCur.btn.removeAttribute('aria-current'); }
    if (cur) { cur.btn.classList.add('br-current'); cur.btn.setAttribute('aria-current', 'true'); }
    this._tocCur = cur;
  };
  P._tocJump = function (si) {
    this.closeToc(true);
    this._userNav();
    this.goToSection(si);
    try { this.root.focus({ preventScroll: true }); } catch (e) { this.root.focus(); }
  };
  P.openToc = function () {
    if (!this.toc || !this.total || this._tocOpen) return;
    this._tocOpen = true;
    this.root.classList.add('br-toc-open');
    this.tocBtn.setAttribute('aria-expanded', 'true');
    var self = this, cur = this._tocCur;
    var focusIt = function () {
      var t = cur ? cur.btn : self.tocScroll.querySelector('.br-toc-item');
      if (!t) return;
      if (cur) self.tocScroll.scrollTop = Math.max(0, t.offsetTop - self.tocScroll.clientHeight / 2 + t.offsetHeight / 2);
      try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
    };
    if (window.requestAnimationFrame) requestAnimationFrame(focusIt); else setTimeout(focusIt, 0);
    this._emit('toc', { open: true });
  };
  P.closeToc = function (noFocus) {
    if (!this._tocOpen) return;
    this._tocOpen = false;
    this.root.classList.remove('br-toc-open');
    this.tocBtn.setAttribute('aria-expanded', 'false');
    if (noFocus !== true) { try { this.tocBtn.focus({ preventScroll: true }); } catch (e) { /* hidden */ } }
    this._emit('toc', { open: false });
  };
  P.toggleToc = function () { if (this._tocOpen) this.closeToc(); else this.openToc(); };
  P.getToc = function () {                              // [{ title, page, section }] for host apps
    var self = this;
    return (this._tocItems || []).map(function (t) {
      var s = self.sections[t.si];
      return { title: (s.title || '').trim() || 'Beginning', page: s.start + 1, section: t.si };
    });
  };

  P._busy = function (msg) {
    if (!msg) { this.loading.hidden = true; return; }
    this.loading.textContent = msg; this.loading.hidden = false;
  };

  /* ---------------------------- binding ------------------------------ */
  P._bind = function () {
    var self = this;
    var on = function (t, type, fn, opt) {
      t.addEventListener(type, fn, opt);
      self._off.push(function () { t.removeEventListener(type, fn, opt); });
    };
    on(this.stage, 'pointerdown', function (e) { self._onDown(e); });
    on(this.stage, 'pointermove', function (e) { self._onMove(e); });
    on(this.stage, 'pointerup', function (e) { self._onUp(e); });
    on(this.stage, 'pointercancel', function (e) { self._onUp(e); });
    on(this.stage, 'wheel', function (e) { self._onWheel(e); }, { passive: false });
    on(this.root, 'keydown', function (e) { self._onKey(e); });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self._onResize(); });
      this._ro.observe(this.host);
    } else on(window, 'resize', function () { self._onResize(); });
  };

  P._onResize = function () {
    var self = this;
    clearTimeout(this._rt);
    this._rt = setTimeout(function () {
      if (!self.doc || !self.g) return;
      var r = self.stage.getBoundingClientRect();
      if (Math.floor(r.width) === self.g.W && Math.floor(r.height) === self.g.H) return;
      self._relayout();
    }, 140);
  };

  /* ----------------------------- loading ----------------------------- */
  P.open = function (source, meta) {
    var self = this; meta = meta || {};
    var tok = ++this._token;
    this._busy('Opening book\u2026');
    var max = this.o.maxBlocksPerSection;
    return Promise.resolve().then(function () {
      self._disposeDoc();
      if (typeof source === 'string') {
        return /^\s*</.test(source) ? parseHTMLString(source, meta, max) : parseText(source, meta, max);
      }
      return toArrayBuffer(source).then(function (buf) {
        if (isZip(buf)) return self._parseEPUB(buf, meta);
        return parseText(new TextDecoder('utf-8').decode(buf), meta, max);
      });
    }).then(function (doc) {
      if (tok !== self._token) return;
      doc.id = meta.id || doc.title || 'book';
      self.doc = doc; self.sections = doc.sections;
      if (!self.sections.length) throw new Error('This book has no readable content.');
      return self._layout(self._loadPos());
    }).catch(function (err) {
      if (tok !== self._token) return;
      self._busy('Could not open this book.');
      self._emit('error', err);
      throw err;
    });
  };

  P._disposeDoc = function () {
    this._urls.forEach(function (u) { URL.revokeObjectURL(u); });
    this._urls = [];
    this.doc = null; this.sections = []; this.total = 0; this.pos = 0;
  };

  P._parseEPUB = function (buf, meta) {
    var self = this;
    var JSZip = this.o.JSZip || global.JSZip;
    if (!JSZip) return Promise.reject(new Error('EPUB support needs JSZip (load jszip.min.js or pass options.JSZip).'));
    var max = this.o.maxBlocksPerSection;
    var cache = {};
    return JSZip.loadAsync(buf).then(function (zip) {
      var getFile = function (p) {
        var f = zip.file(p); if (f) return f;
        try { f = zip.file(decodeURIComponent(p)); } catch (e) { /* bad escape */ }
        return f || null;
      };
      var read = function (p) { var f = getFile(p); return f ? f.async('string') : Promise.resolve(null); };

      return read('META-INF/container.xml').then(function (cx) {
        if (!cx) throw new Error('Not a valid EPUB (missing container.xml).');
        var rf = parseXML(cx).getElementsByTagName('rootfile')[0];
        var opfPath = rf.getAttribute('full-path');
        return read(opfPath).then(function (opfStr) {
          var opf = parseXML(opfStr), base = dirname(opfPath), items = {};
          Array.prototype.forEach.call(opf.getElementsByTagName('item'), function (it) {
            items[it.getAttribute('id')] = {
              href: joinPath(base, it.getAttribute('href') || ''),
              type: it.getAttribute('media-type') || '',
              props: it.getAttribute('properties') || ''
            };
          });
          var spine = Array.prototype.map.call(opf.getElementsByTagName('itemref'), function (r) {
            return items[r.getAttribute('idref')];
          }).filter(Boolean);
          var tEl = opf.getElementsByTagNameNS('*', 'title')[0];
          var aEl = opf.getElementsByTagNameNS('*', 'creator')[0];
          var title = meta.title || (tEl ? tEl.textContent.trim() : '');
          var author = meta.author || (aEl ? aEl.textContent.trim() : '');

          // Table of contents → chapter titles (best effort)
          var toc = {}, all = Object.keys(items).map(function (k) { return items[k]; });
          var navItem = all.filter(function (i) { return /\bnav\b/.test(i.props); })[0];
          var ncx = all.filter(function (i) { return i.type === 'application/x-dtbncx+xml'; })[0];
          var tocP = Promise.resolve();
          if (navItem) {
            tocP = read(navItem.href).then(function (s) {
              if (!s) return;
              var d = new DOMParser().parseFromString(s, 'text/html');
              Array.prototype.forEach.call(d.querySelectorAll('nav a[href]'), function (a) {
                var p = joinPath(dirname(navItem.href), a.getAttribute('href').split('#')[0]);
                if (!(p in toc)) toc[p] = a.textContent.trim();
              });
            });
          } else if (ncx) {
            tocP = read(ncx.href).then(function (s) {
              if (!s) return;
              Array.prototype.forEach.call(parseXML(s).getElementsByTagName('navPoint'), function (np) {
                var c = np.getElementsByTagName('content')[0], l = np.getElementsByTagName('text')[0];
                if (!c || !l) return;
                var p = joinPath(dirname(ncx.href), c.getAttribute('src').split('#')[0]);
                if (!(p in toc)) toc[p] = l.textContent.trim();
              });
            });
          }

          return tocP.catch(function () { }).then(function () {
            var sections = [];
            var chain = Promise.resolve();
            spine.forEach(function (it) {
              chain = chain.then(function () {
                if (!/html|xml/.test(it.type)) return;
                return read(it.href).then(function (str) {
                  if (!str) return;
                  var d = new DOMParser().parseFromString(str, 'application/xhtml+xml');
                  if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(str, 'text/html');
                  var body = d.body || d.getElementsByTagName('body')[0];
                  if (!body) return;
                  sanitize(body);
                  return self._inlineImages(body, it.href, getFile, cache).then(function () {
                    var nodes = topLevelNodes(body);
                    if (!nodes.length) return;
                    var secs = makeSections(nodes, { splitHeadings: false, max: max, title: '' });
                    secs.forEach(function (s, i) {
                      if (!s.frag.textContent.trim() && !s.frag.querySelector('img,svg,image')) return;
                      if (i === 0) s.title = toc[it.href] || s.title;
                      sections.push(s);
                    });
                  });
                });
              });
            });
            return chain.then(function () {
              return { title: title || 'Untitled', author: author, sections: sections };
            });
          });
        });
      });
    });
  };

  P._inlineImages = function (body, basePath, getFile, cache) {
    var self = this, dir = dirname(basePath), tasks = [];
    Array.prototype.forEach.call(body.querySelectorAll('img, image'), function (n) {
      var attr = n.hasAttribute('src') ? 'src' : n.hasAttribute('xlink:href') ? 'xlink:href' : n.hasAttribute('href') ? 'href' : null;
      if (!attr) return;
      var v = n.getAttribute(attr);
      if (!v || /^(data:|https?:|blob:)/i.test(v)) return;
      var p = joinPath(dir, v.split('#')[0]);
      tasks.push((function () {
        if (cache[p]) { n.setAttribute(attr, cache[p]); return Promise.resolve(); }
        var f = getFile(p);
        if (!f) { n.removeAttribute(attr); return Promise.resolve(); }
        return f.async('arraybuffer').then(function (ab) {
          var url = URL.createObjectURL(new Blob([ab], { type: mimeOf(p) }));
          self._urls.push(url); cache[p] = url; n.setAttribute(attr, url);
        });
      })());
    });
    return Promise.all(tasks);
  };

  /* --------------------------- geometry ------------------------------ */
  P._calcGeometry = function () {
    var r = this.stage.getBoundingClientRect();
    var W = Math.max(200, Math.floor(r.width)), H = Math.max(200, Math.floor(r.height));
    var mode = this.o.mode;
    if (mode === 'auto') mode = (W >= this.o.spreadMinWidth && W / H > 1.15) ? 'spread' : 'single';
    var pw, ph, bleed = false, m;
    if (mode === 'spread') {
      m = Math.round(Math.min(W, H) * 0.05);
      ph = Math.min(H - 2 * m, Math.floor((W - 2 * m) / 2 / 0.66));
      pw = Math.min(Math.floor((W - 2 * m) / 2), Math.floor(ph * 0.74));
    } else if (W < 600) {          // phone: paper fills the screen
      pw = W; ph = H; bleed = true;
    } else {                       // tablet / narrow window: one sheet with a desk margin
      m = Math.round(Math.min(W, H) * 0.04);
      ph = H - 2 * m; pw = Math.min(W - 2 * m, Math.floor(ph * 0.72));
    }
    var padx = clamp(Math.round(pw * 0.09), 18, 56);
    var pt = clamp(Math.round(ph * 0.065), 28, 60);
    var pb = clamp(Math.round(ph * 0.075), 32, 64);
    return {
      W: W, H: H, mode: mode, bleed: bleed, pageW: pw, pageH: ph,
      padX: padx, padTop: pt, padBot: pb,
      cw: pw - 2 * padx, ch: ph - pt - pb, gap: padx * 2
    };
  };
  P._applyGeometry = function () {
    var g = this.g, s = this.root.style;
    s.setProperty('--br-pw', g.pageW + 'px'); s.setProperty('--br-ph', g.pageH + 'px');
    s.setProperty('--br-padx', g.padX + 'px'); s.setProperty('--br-pt', g.padTop + 'px');
    s.setProperty('--br-pb', g.padBot + 'px'); s.setProperty('--br-cw', g.cw + 'px');
    s.setProperty('--br-ch', g.ch + 'px'); s.setProperty('--br-gap', g.gap + 'px');
    this.root.dataset.mode = g.mode;
    this.root.dataset.bleed = g.bleed ? '1' : '0';
    this.book.style.perspective = Math.round(g.pageW * 2.6) + 'px';
  };

  /* --------------------------- pagination ---------------------------- */
  P._makeFlow = function (sec, pageInSec) {
    var flow = el('div', 'br-flow');
    flow.appendChild(sec.frag.cloneNode(true));
    if (pageInSec) flow.style.transform = 'translateX(' + (-pageInSec * (this.g.cw + this.g.gap)) + 'px)';
    return flow;
  };
  P._measure = function (sec) {
    var self = this, m = el('div', 'br-measure'), flow = this._makeFlow(sec, 0);
    m.appendChild(flow); this.root.appendChild(m);
    return imagesReady(flow).then(function () {
      var sw = flow.scrollWidth; m.remove();
      return Math.max(1, Math.round((sw + self.g.gap) / (self.g.cw + self.g.gap)));
    });
  };

  P._layout = function (locator) {
    var self = this, tok = ++this._layoutTok;
    this._cancelFlip(); this.resetZoom(false);
    this.g = this._calcGeometry(); this._applyGeometry();
    this._busy('Preparing pages\u2026');
    var secs = this.sections, t = performance.now(), chain = Promise.resolve();
    secs.forEach(function (sec, i) {
      chain = chain.then(function () {
        if (tok !== self._layoutTok) return;
        return self._measure(sec).then(function (n) {
          sec.count = n;
          if (performance.now() - t > 14) {
            self._busy('Preparing pages\u2026 ' + Math.round((i + 1) / secs.length * 100) + '%');
            t = performance.now(); return tick();
          }
        });
      });
    });
    return chain.then(function () {
      if (tok !== self._layoutTok) return;
      var n = 0; secs.forEach(function (s) { s.start = n; n += s.count; });
      self.total = n;
      self._buildSlots();
      self._renderToc();
      self.pos = self._posForAnchor(locator ? self._fromLocator(locator) : 0);
      self._render();
      self._busy(null);
      self._emit('ready', { title: self.doc.title, author: self.doc.author, total: self.total, mode: self.g.mode });
    });
  };
  P._relayout = function () {
    var loc = this.total ? this._locator() : null;
    return this._layout(loc);
  };

  P._buildSlots = function () {
    var g = this.g; this.book.textContent = ''; this.slots = {};
    var names = g.mode === 'spread' ? ['left', 'right'] : ['single'];
    for (var i = 0; i < names.length; i++) {
      var n = names[i], slot = el('div', 'br-slot'), z = el('div', 'br-zoom');
      slot.dataset.side = n;
      slot.style.left = (n === 'right' ? g.pageW : 0) + 'px';
      slot.appendChild(z); this.book.appendChild(slot);
      this.slots[n] = { slot: slot, zoom: z };
    }
  };

  /* ------------------------ page ↔ position maths -------------------- */
  P._locate = function (idx) {            // global page → { si, pi }
    var s = this.sections, lo = 0, hi = s.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (s[mid].start <= idx) lo = mid; else hi = mid - 1; }
    return { si: lo, pi: idx - s[lo].start };
  };
  P._spread = function () { return this.g && this.g.mode === 'spread'; };
  P._maxPos = function () { return this._spread() ? Math.floor(this.total / 2) : this.total - 1; };
  P._anchor = function () { return this._spread() ? (this.pos === 0 ? 0 : 2 * this.pos - 1) : this.pos; };
  P._posForAnchor = function (a) {
    a = clamp(a, 0, Math.max(0, this.total - 1));
    return this._spread() ? Math.ceil(a / 2) : a;
  };
  P._pages = function (pos) {
    if (this._spread()) {
      var r = 2 * pos;
      return { left: pos === 0 ? null : 2 * pos - 1, right: r < this.total ? r : null };
    }
    return { single: pos };
  };
  P._layoutSig = function () {          // same value ⇒ page numbers mean the same thing
    var g = this.g || {};
    return [this.total, this.fontSize, g.mode, g.pageW, g.pageH].join('|');
  };
  P._locator = function () {
    var a = this._anchor(), l = this._locate(a), sec = this.sections[l.si];
    return {
      si: l.si,                       // chapter / section index
      page: a,                        // 0-based global page index
      frac: l.pi / sec.count,         // position inside the chapter (survives re-pagination)
      n: this.sections.length,        // sanity check for the chapter index
      sig: this._layoutSig()
    };
  };
  P._fromLocator = function (l) {
    var last = this.sections.length - 1;
    if (typeof l.page === 'number' && l.sig && l.sig === this._layoutSig()) {
      return clamp(l.page | 0, 0, Math.max(0, this.total - 1));       // exact page, nothing changed
    }
    var si = clamp(l.si | 0, 0, last);
    if (l.n && l.n !== this.sections.length) si = clamp(si, 0, last);   // book changed: best effort
    var sec = this.sections[si];
    return sec.start + clamp(Math.floor((l.frac || 0) * sec.count + 1e-6), 0, sec.count - 1);
  };

  /* ---------------------------- faces -------------------------------- */
  P._face = function (idx, side) {
    var f = el('div', 'br-face br-side-' + side);
    if (idx == null || idx < 0 || idx >= this.total) { f.classList.add('br-blank'); return f; }
    var l = this._locate(idx), sec = this.sections[l.si];
    var head = el('div', 'br-head'); head.textContent = sec.title || '';
    var clip = el('div', 'br-clip'); clip.appendChild(this._makeFlow(sec, l.pi));
    var folio = el('div', 'br-folio'); folio.textContent = String(idx + 1);
    f.appendChild(head); f.appendChild(clip); f.appendChild(folio);
    return f;
  };
  P._setSlot = function (name, idx) {
    var z = this.slots[name].zoom; z.textContent = '';
    z.appendChild(this._face(idx, name));
  };
  P._render = function () {
    if (!this.total) return;
    var p = this._pages(this.pos);
    if (this._spread()) { this._setSlot('left', p.left); this._setSlot('right', p.right); }
    else this._setSlot('single', p.single);
    this._updateUI();
  };

  P._updateUI = function () {
    var idx = this._anchor(), l = this._locate(idx), sec = this.sections[l.si];
    var p = this._pages(this.pos), label;
    if (this._spread()) {
      var nums = [p.left, p.right].filter(function (v) { return v != null; }).map(function (v) { return v + 1; });
      label = (nums.length > 1 ? 'Pages ' + nums[0] + '\u2013' + nums[1] : 'Page ' + nums[0]) + ' of ' + this.total;
    } else label = 'Page ' + (idx + 1) + ' of ' + this.total;
    if (this.slider) { this.slider.max = Math.max(0, this.total - 1); this.slider.value = idx; }
    if (this.label) this.label.textContent = label;
    if (this.elTitle) { this.elTitle.textContent = this.doc.title; this.elChapter.textContent = sec.title || ''; }
    this.live.textContent = label;
    this._markToc(l.si);
    this._savePos();
    this._emit('relocate', {
      page: idx + 1, total: this.total, section: l.si, sectionTitle: sec.title,
      progress: this.total > 1 ? idx / (this.total - 1) : 1
    });
  };

  /* ---------------------------- navigation --------------------------- */
  P.next = function () { this._turn(1); };
  P.prev = function () { this._turn(-1); };
  P.goTo = function (page) {           // 0-based global page index
    if (!this.total) return;
    this._cancelFlip(); this.resetZoom(false);
    var pos = this._posForAnchor(page);
    if (pos === this.pos) { this._render(); return; }
    this.pos = pos; this._render();
  };
  P.goToSection = function (i) {
    if (this.sections[i]) this.goTo(this.sections[i].start);
  };
  P._userNav = function () {
    if (this._autoHide) { this._autoHide = false; this.toggleToolbars(false); }
  };
  P._turn = function (dir) {
    if (!this.total) return;
    if (this._zoom.slot) this.resetZoom(false);
    if (this._flip) { this._queued = dir; return; }
    var to = this.pos + dir;
    if (to < 0 || to > this._maxPos()) return;
    this._userNav();
    if (this._reduced.matches) { this.pos = to; this._render(); return; }
    var f = this._prepareFlip(dir);
    if (f) this._finishFlip(f, true);
  };

  /* ------------------------- 3D page flip ---------------------------- */
  P._prepareFlip = function (dir) {
    if (this._flip) return null;
    var from = this.pos, to = from + dir;
    if (to < 0 || to > this._maxPos()) return null;
    var g = this.g, spread = this._spread(), A = this._pages(from), B = this._pages(to);
    var front, back, origin, left, castEdge, castLeft;
    if (spread) {
      if (dir > 0) {                       // right page lifts and lands on the left
        this._setSlot('right', B.right);   // new right page is revealed underneath
        front = this._face(A.right, 'right'); back = this._face(B.left, 'left');
        origin = 'left'; left = g.pageW; castEdge = 'left'; castLeft = g.pageW;
      } else {                             // left page lifts and lands on the right
        this._setSlot('left', B.left);
        front = this._face(A.left, 'left'); back = this._face(B.right, 'right');
        origin = 'right'; left = 0; castEdge = 'right'; castLeft = 0;
      }
    } else {
      origin = 'left'; left = 0; castEdge = 'left'; castLeft = 0;
      if (dir > 0) {                       // current sheet lifts away, next page underneath
        this._setSlot('single', B.single);
        front = this._face(A.single, 'single');
      } else {                             // previous sheet swings in from the left
        front = this._face(B.single, 'single');
      }
      back = this._face(null, 'single');   // reverse side of the sheet
    }
    var leaf = el('div', 'br-leaf');
    leaf.dataset.origin = origin;
    leaf.style.left = left + 'px';
    leaf.style.transformOrigin = origin + ' center';
    var fr = el('div', 'br-leaf-face br-leaf-front'), bk = el('div', 'br-leaf-face br-leaf-back');
    var shF = el('div', 'br-shade'), shB = el('div', 'br-shade');
    fr.appendChild(front); fr.appendChild(shF); bk.appendChild(back); bk.appendChild(shB);
    leaf.appendChild(fr); leaf.appendChild(bk);
    var cast = el('div', 'br-cast'); cast.dataset.edge = castEdge; cast.style.left = castLeft + 'px';
    this.book.appendChild(cast); this.book.appendChild(leaf);

    var angle = (spread && dir < 0) ? function (p) { return 180 * p; }
              : (!spread && dir < 0) ? function (p) { return -180 * (1 - p); }
              : function (p) { return -180 * p; };
    var f = { dir: dir, from: from, to: to, p: 0, leaf: leaf, cast: cast, shF: shF, shB: shB, angle: angle, raf: 0 };
    this._flip = f;
    this._setFlip(f, 0);
    return f;
  };
  P._setFlip = function (f, p) {
    f.p = p;
    var a = f.angle(p), A = Math.abs(a);
    f.leaf.style.transform = 'rotateY(' + a.toFixed(2) + 'deg)';
    f.shF.style.opacity = (Math.min(A, 90) / 90 * 0.55).toFixed(3);
    f.shB.style.opacity = (Math.min(180 - A, 90) / 90 * 0.55).toFixed(3);
    f.cast.style.opacity = (Math.sin(p * Math.PI) * 0.55).toFixed(3);
  };
  P._animate = function (f, to, ms) {
    var self = this;
    return new Promise(function (res) {
      var from = f.p, t0 = performance.now();
      var step = function (now) {
        var t = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
        var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        self._setFlip(f, from + (to - from) * e);
        if (t < 1) f.raf = requestAnimationFrame(step); else res();
      };
      f.raf = requestAnimationFrame(step);
    });
  };
  P._finishFlip = function (f, commit) {
    var self = this, dist = Math.abs((commit ? 1 : 0) - f.p);
    var ms = this.o.flipDuration * Math.max(0.22, dist);
    return this._animate(f, commit ? 1 : 0, ms).then(function () {
      if (self._flip !== f) return;
      self._endFlip(f, commit);
    });
  };
  P._endFlip = function (f, commit) {
    cancelAnimationFrame(f.raf);
    f.leaf.remove(); f.cast.remove();
    this._flip = null;
    if (commit) this.pos = f.to;
    this._render();
    if (this._queued) { var d = this._queued; this._queued = 0; this._turn(d); }
  };
  P._cancelFlip = function () {
    var f = this._flip; if (!f) return;
    cancelAnimationFrame(f.raf);
    f.leaf.remove(); f.cast.remove();
    this._flip = null; this._queued = 0;
    this._render();
  };

  /* --------------------------- pinch / pan --------------------------- */
  P._slotAt = function (clientX) {
    if (!this._spread()) return 'single';
    var r = this.book.getBoundingClientRect();
    return clientX < r.left + r.width / 2 ? 'left' : 'right';
  };
  P._activate = function (name) {
    var z = this._zoom, s = this.slots[name];
    s.zoom.style.transition = ''; s.zoom.style.willChange = 'transform';
    s.slot.classList.add('is-zoomed');
    z.slot = name;
  };
  P._applyZoom = function () {
    var z = this._zoom, g = this.g; if (!z.slot) return;
    z.tx = clamp(z.tx, g.pageW - g.pageW * z.s, 0);       // pan constraints: the page must
    z.ty = clamp(z.ty, g.pageH - g.pageH * z.s, 0);       // always cover its own window
    this.slots[z.slot].zoom.style.transform =
      'translate3d(' + z.tx.toFixed(1) + 'px,' + z.ty.toFixed(1) + 'px,0) scale(' + z.s.toFixed(4) + ')';
  };
  P._zoomAt = function (cx, cy, factor) {
    if (this._flip || !this.total) return;
    var z = this._zoom, name = z.slot || this._slotAt(cx), slot = this.slots[name];
    var r = slot.slot.getBoundingClientRect(), lx = cx - r.left, ly = cy - r.top;
    var s0 = z.slot ? z.s : 1, px = (lx - (z.slot ? z.tx : 0)) / s0, py = (ly - (z.slot ? z.ty : 0)) / s0;
    var s = clamp(s0 * factor, 1, this.o.maxZoom);
    if (s <= 1.001) { this.resetZoom(true); return; }
    this._activate(name);
    z.s = s; z.tx = lx - s * px; z.ty = ly - s * py;
    this._applyZoom();
    this._emit('zoom', { scale: z.s });
  };
  P.zoomBy = function (factor) {
    var r = this.stage.getBoundingClientRect();
    this._zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };
  P.resetZoom = function (animate) {
    var z = this._zoom; if (!z.slot) return;
    var name = z.slot, slot = this.slots[name], self = this;
    z.slot = null; z.s = 1; z.tx = 0; z.ty = 0;
    if (!slot) return;
    var done = function () {
      if (self._zoom.slot === name) return;               // user zoomed again meanwhile
      slot.zoom.style.transition = ''; slot.zoom.style.transform = '';
      slot.zoom.style.willChange = ''; slot.slot.classList.remove('is-zoomed');
    };
    if (animate && !this._reduced.matches) {
      slot.zoom.style.transition = 'transform .22s ease'; slot.zoom.style.transform = '';
      setTimeout(done, 240);
    } else { slot.zoom.style.transform = ''; done(); }
    this._emit('zoom', { scale: 1 });
  };

  P._beginPinch = function () {
    var pts = Array.from(this._ptrs.values()), a = pts[0], b = pts[1], z = this._zoom;
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    var name = z.slot || this._slotAt(mx), slot = this.slots[name];
    var r = slot.slot.getBoundingClientRect();
    var s0 = z.slot ? z.s : 1, tx0 = z.slot ? z.tx : 0, ty0 = z.slot ? z.ty : 0;
    this._activate(name);
    z.s = s0; z.tx = tx0; z.ty = ty0;
    this._pinch = {
      name: name, d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), s0: s0,
      px: (mx - r.left - tx0) / s0, py: (my - r.top - ty0) / s0   // content point under the fingers
    };
    this._g = { mode: 'pinch' };
  };
  P._movePinch = function () {
    var pts = Array.from(this._ptrs.values()), a = pts[0], b = pts[1], pc = this._pinch, z = this._zoom;
    var r = this.slots[pc.name].slot.getBoundingClientRect();
    var mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    z.s = clamp(pc.s0 * d / pc.d0, 1, this.o.maxZoom);
    z.tx = mx - z.s * pc.px; z.ty = my - z.s * pc.py;       // follows the fingers → pinch + pan together
    this._applyZoom();
  };
  P._endPinch = function () {
    this._pinch = null;
    if (this._zoom.s <= 1.03) this.resetZoom(true);
    else { this._emit('zoom', { scale: this._zoom.s }); }
  };

  /* ---------------------------- pointer events ----------------------- */
  P._onDown = function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.total) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._ptrs.size === 2) {
      if (this._g && this._g.mode === 'drag' && this._flip) this._finishFlip(this._flip, false);
      if (this._flip) this._g = { mode: 'none' };
      else this._beginPinch();
    } else if (this._ptrs.size === 1) {
      this._g = { mode: 'tap', x0: e.clientX, y0: e.clientY, t0: performance.now() };
    }
  };
  P._onMove = function (e) {
    var p = this._ptrs.get(e.pointerId); if (!p) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this._pinch && this._ptrs.size >= 2) { this._movePinch(); return; }
    var g = this._g, z = this._zoom; if (!g) return;
    if (g.mode === 'tap') {
      var tx = e.clientX - g.x0, ty = e.clientY - g.y0;
      if (Math.hypot(tx, ty) < 10) return;
      if (z.slot) g.mode = 'pan';
      else if (Math.abs(tx) > Math.abs(ty) * 1.2 && !this._flip) {
        var dir = tx < 0 ? 1 : -1, f = this._prepareFlip(dir);
        if (f) { g.mode = 'drag'; g.f = f; g.dir = dir; g.span = this.g.pageW * 0.9; g.samples = []; this._userNav(); }
        else g.mode = 'none';
      } else g.mode = 'none';
    }
    if (g.mode === 'pan') {
      z.tx += dx; z.ty += dy; this._applyZoom();
    } else if (g.mode === 'drag') {
      var raw = g.dir > 0 ? g.x0 - e.clientX : e.clientX - g.x0;
      var prog = clamp(raw / g.span, 0, 1);
      this._setFlip(g.f, prog);
      g.samples.push({ t: performance.now(), p: prog });
      if (g.samples.length > 5) g.samples.shift();
    }
  };
  P._onUp = function (e) {
    if (!this._ptrs.delete(e.pointerId)) return;
    if (this._pinch && this._ptrs.size < 2) {
      this._endPinch();
      this._g = this._ptrs.size && this._zoom.slot ? { mode: 'pan' } : { mode: 'none' };
      return;
    }
    var g = this._g; if (!g) return;
    if (this._ptrs.size === 0) {
      if (g.mode === 'tap' && e.type === 'pointerup' && performance.now() - g.t0 < 500) this._onTap(e.clientX, e.clientY);
      else if (g.mode === 'drag') this._releaseDrag(g, e.type === 'pointercancel');
      this._g = null;
    }
  };
  P._releaseDrag = function (g, cancelled) {
    var f = g.f; if (!f || this._flip !== f) return;
    var s = g.samples, v = 0;
    if (s.length > 1) { var a = s[0], b = s[s.length - 1]; v = (b.p - a.p) / Math.max(1, b.t - a.t); } // progress / ms
    var commit = !cancelled && ((f.p > 0.4 && v > -0.001) || v > 0.0012);
    this._finishFlip(f, commit);
  };
  P._onTap = function (x, y) {
    var r = this.stage.getBoundingClientRect(), fx = (x - r.left) / r.width, z = this._zoom;
    var tz = this.o.tapZone, now = performance.now(), self = this;
    if (z.slot) {                       // zoomed: edges do nothing, double-tap resets
      var lt = this._lastTap;
      clearTimeout(this._tapTimer);
      if (lt && now - lt.t < 300 && Math.hypot(x - lt.x, y - lt.y) < 40) {
        this._lastTap = null; this.resetZoom(true); return;
      }
      this._lastTap = { t: now, x: x, y: y };
      if (fx >= tz && fx <= 1 - tz) this._tapTimer = setTimeout(function () { self.toggleToolbars(); }, 300);
      return;
    }
    this._lastTap = null;
    if (fx < tz) this._turn(-1);
    else if (fx > 1 - tz) this._turn(1);
    else this.toggleToolbars();
  };

  P._onWheel = function (e) {
    if (!this.total) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {                          // trackpad pinch / ctrl+wheel
      this._zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else if (this._zoom.slot) {
      this._zoom.tx -= e.deltaX; this._zoom.ty -= e.deltaY; this._applyZoom();
    } else {
      var now = performance.now(), d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) > 20 && now - this._wheelT > 500) { this._wheelT = now; this._turn(d > 0 ? 1 : -1); }
    }
  };
  P._onKey = function (e) {
    var k = e.key, used = true;
    if (this._tocOpen) {                                   // drawer owns the keyboard while open
      if (k === 'Escape') { this.closeToc(); e.preventDefault(); }
      return;
    }
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) this._turn(1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) this._turn(-1);
    else if (k === 'Home') this.goTo(0);
    else if (k === 'End') this.goTo(this.total - 1);
    else if (k === '+' || k === '=') this.zoomBy(1.25);
    else if (k === '-') this.zoomBy(0.8);
    else if (k === '0' || k === 'Escape') this.resetZoom(true);
    else used = false;
    if (used) e.preventDefault();
  };

  /* ---------------------------- UI / prefs --------------------------- */
  P.toggleToolbars = function (force) {
    var hidden = this.root.classList.contains('br-ui-hidden');
    var show = typeof force === 'boolean' ? force : hidden;
    this.root.classList.toggle('br-ui-hidden', !show);
    this._autoHide = false;
    this._emit('toolbar', { visible: show });
  };
  P.setTheme = function (t) {
    if (THEMES.indexOf(t) < 0) return;
    this.theme = t; this.root.dataset.theme = t; this._savePrefs();
  };
  P.setFontSize = function (px) {
    px = clamp(Math.round(px), 12, 34);
    if (px === this.fontSize) return;
    this.fontSize = px; this.root.style.setProperty('--br-fs', px + 'px');
    this._savePrefs();
    if (this.doc) this._relayout();
  };
  P.getState = function () {
    return {
      page: this.total ? this._anchor() + 1 : 0, total: this.total, mode: this.g && this.g.mode,
      zoom: this._zoom.s, fontSize: this.fontSize, theme: this.theme,
      title: this.doc && this.doc.title
    };
  };

  P._key = function () {
    return this.o.storageKey && this.doc ? this.o.storageKey + ':' + this.doc.id : null;
  };
  P._savePos = function () {
    var k = this._key(); if (!k || !this.total) return;
    try { localStorage.setItem(k, JSON.stringify(this._locator())); } catch (e) { /* private mode */ }
  };
  P._loadPos = function () {
    var k = this._key(); if (!k) return null;
    try {
      var v = JSON.parse(localStorage.getItem(k));
      return v && typeof v === 'object' && isFinite(v.si) ? v : null;
    } catch (e) { return null; }
  };
  P._loadPrefs = function () {
    if (!this.o.storageKey) return {};
    try { return JSON.parse(localStorage.getItem(this.o.storageKey + ':prefs')) || {}; } catch (e) { return {}; }
  };
  P._savePrefs = function () {
    if (!this.o.storageKey) return;
    try {
      localStorage.setItem(this.o.storageKey + ':prefs', JSON.stringify({ fontSize: this.fontSize, theme: this.theme }));
    } catch (e) { /* ignore */ }
  };

  P.destroy = function () {
    this._token++; this._layoutTok++;
    clearTimeout(this._tapTimer); clearTimeout(this._rt);
    this._cancelFlip();
    this._off.forEach(function (fn) { fn(); }); this._off = [];
    if (this._ro) this._ro.disconnect();
    this._disposeDoc();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this._ev = {};
  };

  BookReader.version = '1.1.0';
  return BookReader;
});
