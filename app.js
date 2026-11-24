import {
  openAudio, readBook, buildBook, transcribeAround, findInBook, quoteAt, entryAt,
  readPdfPages, guessFirstNumbered, buildPageIndex, pageOf, renderPdfPage, findTextTables,
} from './align.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

const KEY = 'borkmark.v1';
const MODEL = 'onnx-community/whisper-tiny.en_timestamped';
const LOCATE_BEFORE = 45, LOCATE_AFTER = 15;   // seconds of audio used to find the place when capturing by paragraph
const MERGE_WINDOW = 3000;                 // repeated presses within this many ms count once

// ---------- saved state ----------
let state = { books: [] };
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved && Array.isArray(saved.books)) state = saved;
} catch (e) { /* storage unavailable: run without persistence */ }

// A book's title and author can come from four places. In order of trust:
// typed by you, the book text (EPUB), the audio file's tags, the file name.
function resolveMeta(b) {
  b.edited = b.edited || {}; b.fromText = b.fromText || {}; b.src = b.src || {};
  // Books added before sources were tracked only have the audio's values.
  b.fromAudio = b.fromAudio || { title: b.title || '', author: b.author || '' };
  for (const f of ['title', 'author']) {
    const pick = b.edited[f] ? 'you' : b.fromText[f] ? 'text' : b.fromAudio[f] ? 'audio' : 'file';
    b.src[f] = pick;
    b[f] = pick === 'you' ? b.edited[f] : pick === 'text' ? b.fromText[f] : pick === 'audio' ? b.fromAudio[f]
      : f === 'title' ? (b.audioName || 'Untitled').replace(/\.[^.]+$/, '') : '';
  }
}
state.books.forEach(resolveMeta);

// What each button does. `next` and `prev` are the track buttons a headset or
// watch sends; an action is mark | fwd | back | nextChapter | prevChapter | none.
const DEFAULTS = {
  next: { action: 'mark', secs: 30 },
  prev: { action: 'mark', secs: 30 },
  skipBack: 30, skipFwd: 30,     // on-screen and lock-screen skip buttons
  lockSeek: true,                // lock screen shows skip buttons rather than track buttons
  bgQuotes: false,               // find quotes while the phone is locked
  sounds: true,                  // short tones for bookmark, skip and figures
  figAlert: true,                // chime when the narration reaches a picture or table
  figPause: false,               // …and pause there
  // What a bookmark captures: seconds of audio either side, or whole paragraphs.
  capture: { mode: 'time', before: 45, after: 15, parasBefore: 1, parasAfter: 1 },
  accent: null,                  // custom accent color as #rrggbb, or null for the default green
};
const settings = state.settings = {
  ...DEFAULTS, ...(state.settings || {}),
  next: { ...DEFAULTS.next, ...((state.settings || {}).next || {}) },
  prev: { ...DEFAULTS.prev, ...((state.settings || {}).prev || {}) },
  capture: { ...DEFAULTS.capture, ...((state.settings || {}).capture || {}) },
};
const canWork = () => document.visibilityState !== 'hidden' || settings.bgQuotes;
let saveTimer = null;
function save(now) {
  const write = () => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('Could not save: storage is full'); }
  };
  if (now) { clearTimeout(saveTimer); write(); } else if (!saveTimer) saveTimer = setTimeout(write, 4000);
}

// ---------- diagnostics log ----------
// A short rolling record of button presses and player events, kept on the
// device and copyable from Settings, for working out problems after the fact.
const LOGKEY = 'borkmark.log';
let logLines = [];
try { logLines = JSON.parse(localStorage.getItem(LOGKEY)) || []; } catch (e) {}
function log(msg) {
  const d = new Date();
  const stamp = d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  logLines.push(stamp + (document.visibilityState === 'hidden' ? ' [bg] ' : ' ') + msg);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  try { localStorage.setItem(LOGKEY, JSON.stringify(logLines)); } catch (e) {}
}
log('--- app opened' + ((window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) ? ' (home screen)' : ' (browser)'));

// ---------- crash breadcrumbs ----------
// iOS kills a page that uses too much memory without any error we can catch.
// Noting the current heavy step lets the next launch say what was going on,
// and stops it from walking straight back into the same crash.
const CRUMB = 'borkmark.crumb';
let lastCrash = null;
try { lastCrash = JSON.parse(localStorage.getItem(CRUMB)); } catch (e) {}
function crumb(stage) {
  if (stage) log('work: ' + stage);
  try {
    if (stage) localStorage.setItem(CRUMB, JSON.stringify({ stage, t: Date.now(), playing: !audio.paused }));
    else localStorage.removeItem(CRUMB);
  } catch (e) {}
}
crumb(null);

let adding = false;   // true while a book is being copied in

// ---------- small helpers ----------
const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
// Sheets animate out before they close. Tapping the dimmed area behind one,
// or pressing Escape, closes it the same way.
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
// After a touch, the button that opened a sheet should not be left with a
// focus ring once it closes; keyboard users keep their focus.
let byTouch = false;
document.addEventListener('pointerdown', () => { byTouch = true; }, true);
document.addEventListener('keydown', () => { byTouch = false; }, true);
function closeSheet(d) {
  if (!d.open || d.classList.contains('closing') || (d.id === 'addDlg' && adding)) return;
  const finish = () => {
    d.classList.remove('closing'); d.close();
    d.style.transform = ''; d.style.transition = '';
    if (byTouch && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  };
  if (calm.matches) { finish(); return; }
  d.classList.add('closing');
  setTimeout(finish, 200);
}
for (const d of document.querySelectorAll('dialog')) {
  const locked = () => d.id === 'addDlg' && adding;
  d.addEventListener('cancel', (e) => { e.preventDefault(); if (!locked()) closeSheet(d); });
  d.addEventListener('click', (e) => {
    if (e.target !== d || locked()) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(d);
  });
}

// Swipe down to close a sheet. The sheet follows the finger; letting go past
// a third of the way, or with a quick flick, closes it, otherwise it springs
// back. A swipe starts from the sheet's header at any time, or from anywhere
// in the sheet once its content is scrolled to the top, so it never fights
// with scrolling a long list. Sliders and text fields are left alone.
for (const d of document.querySelectorAll('dialog.bottom, #settingsDlg')) {
  let g = null;
  d.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || d.classList.contains('closing')) return;
    if (e.target.closest('input, select, textarea')) return;
    const header = d.firstElementChild;
    const inHeader = (header && header.contains(e.target)) || e.touches[0].clientY - d.getBoundingClientRect().top < 48;
    if (!inHeader && d.scrollTop > 0) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, dy: 0, dragging: false };
  }, { passive: true });
  d.addEventListener('touchmove', (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;                  // not moved enough to tell
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { g = null; return; }   // upward or sideways: not ours
      g.dragging = true;
      d.style.transition = 'none';
    }
    if (e.cancelable) e.preventDefault();
    g.dy = Math.max(0, dy);
    d.style.transform = 'translateY(' + g.dy + 'px)';
  }, { passive: false });
  const release = (e) => {
    const was = g;
    g = null;
    if (!was || !was.dragging) return;
    const speed = was.dy / Math.max(1, e.timeStamp - was.at);             // pixels per millisecond
    const far = was.dy > Math.min(140, d.offsetHeight / 3);
    if (e.type === 'touchend' && (far || (speed > 0.5 && was.dy > 30))) { closeSheet(d); return; }
    d.style.transition = 'transform 0.2s';
    d.style.transform = '';
    setTimeout(() => { d.style.transition = ''; }, 220);
  };
  d.addEventListener('touchend', release);
  d.addEventListener('touchcancel', release);
}

// Text that is too long for its line slides back and forth so it can be
// read. `node` is the fixed-width line; its text lives in an inner span.
function setScroll(node, text) {
  if (node.dataset.text === text) return;      // unchanged: leave any animation running
  node.dataset.text = text;
  let inner = node.firstElementChild;
  if (!inner || !inner.classList.contains('mq')) { inner = el('span', 'mq'); node.replaceChildren(inner); }
  inner.textContent = text;
  fitScroll(node);
}
function fitScroll(node) {
  const inner = node.firstElementChild;
  if (!inner || !node.clientWidth) return;     // not on screen yet; refitted when it is
  node.classList.remove('scrolls');
  const over = inner.scrollWidth - node.clientWidth;
  if (over <= 6 || calm.matches) return;
  inner.style.setProperty('--shift', -over + 'px');
  inner.style.setProperty('--dur', Math.max(7, 5 + over / 16) + 's');   // about 30 pixels a second, with pauses
  node.classList.add('scrolls');
}
const refitScrolls = () => document.querySelectorAll('.scroller').forEach(fitScroll);
window.addEventListener('resize', refitScrolls);
// Re-measure whenever a line's own width changes (a cover appearing beside it,
// a screen sliding in), so the slide distance is never based on a stale width.
if (window.ResizeObserver) {
  const watcher = new ResizeObserver((entries) => entries.forEach((e) => fitScroll(e.target)));
  document.querySelectorAll('.scroller').forEach((n) => watcher.observe(n));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  // Shown as a popover so it sits above any open sheet rather than behind it.
  if (t.showPopover) { try { t.hidePopover(); } catch (e) {} try { t.showPopover(); } catch (e) {} }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { if (!t.classList.contains('show') && t.hidePopover) { try { t.hidePopover(); } catch (e) {} } }, 250);
  }, 2200);
}
// iOS only shows a button's pressed look if the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true });

// iOS gives .m4b files no usable MIME type, and Safari won't play a blob
// without one, so label the blob from its first bytes.
async function playable(f) {
  const h = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...h.subarray(4, 8)) === 'ftyp') return f.slice(0, f.size, 'audio/mp4');
  if ((h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return f.slice(0, f.size, 'audio/mpeg');
  return f;
}

// ---------- on-device file storage ----------
let storeWorker = null, storeSeq = 0;
const storeJobs = new Map();
function store(op, dir, name, blob, onProgress) {
  if (!storeWorker) {
    storeWorker = new Worker('./store-worker.js');
    storeWorker.onmessage = (e) => {
      const job = storeJobs.get(e.data.id);
      if (!job) return;
      if (e.data.progress != null) { if (job.onProgress) job.onProgress(e.data.progress); return; }
      storeJobs.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++storeSeq;
    storeJobs.set(id, { resolve, reject, onProgress });
    storeWorker.postMessage({ id, op, dir, name, blob });
  });
}
async function stored(dir, name) {
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir);
    return await (await d.getFileHandle(name)).getFile();
  } catch (e) { return null; }
}

// The book text, plus where its contents entries and print pages fall in it.
async function storeText(id, doc) {
  await store('write', id, 'text', new Blob([doc.text], { type: 'text/plain' }));
  await store('write', id, 'meta', new Blob([JSON.stringify({ toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true })], { type: 'application/json' }));
  for (let i = 0; i < doc.images.length; i++) await store('write', id, 'img-' + i, doc.images[i]);
}

// ---------- library ----------
const thumbUrls = [];
async function renderLibrary() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const ul = $('books');
  ul.textContent = '';
  $('emptyLib').hidden = state.books.length > 0;
  for (const b of state.books) {
    const btn = el('button', 'book');
    const img = el('img', 'thumb');
    img.alt = '';
    const info = el('div');
    info.append(el('div', 'name', b.title));
    const n = b.marks.length;
    info.append(el('div', 'muted', [b.author, fmt(b.duration), n ? n + (n === 1 ? ' bookmark' : ' bookmarks') : ''].filter(Boolean).join(' · ')));
    const bar = el('div', 'bar'), fill = el('div');
    fill.style.width = Math.round(100 * (b.position || 0) / (b.duration || 1)) + '%';
    bar.append(fill); info.append(bar);
    btn.append(img, info);
    // The tapped cover grows into the player's cover. If this book is the
    // one in the mini player, that cover is the one that grows instead.
    btn.addEventListener('click', () => morph(() => openBook(b.id, img.getAttribute('src')), cur && cur.book === b ? null : img));
    const li = el('li'); li.append(btn); ul.append(li);
    if (b.hasCover) stored(b.id, 'cover').then((f) => {
      if (!f) return;
      const u = URL.createObjectURL(f); thumbUrls.push(u); img.src = u;
    });
  }
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage != null && quota) $('storage').textContent = 'Using ' + (usage / 1048576).toFixed(0) + ' MB of about ' + (quota / 1073741824).toFixed(1) + ' GB available to this app.';
  }
}

// ---------- adding a book ----------
// The three files a book can have. Only the audio is required.
const PICKS = [
  { key: 'Audio', hint: 'M4B or MP3 · required' },
  { key: 'Text', hint: 'EPUB or TXT · for exact quotes' },
  { key: 'Pdf', hint: 'PDF of the print edition · page numbers' },
];
function renderPick({ key, hint }) {
  const f = $('add' + key).files[0];
  $('add' + key + 'Name').textContent = f ? f.name + ' · ' + (f.size < 1048576 ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : (f.size / 1048576).toFixed(0) + ' MB') : hint;
  $('pick' + key).classList.toggle('chosen', !!f);
}
// Progress while a book is being added: a message, and how far along (0 to 1).
function addSay(msg, frac) {
  $('addStatus').textContent = msg; $('addStatus').className = 'muted';
  $('addProgress').style.visibility = frac == null ? 'hidden' : 'visible';   // keeps its space, so the sheet doesn't jump
  if (frac != null) $('addFill').style.width = Math.round(frac * 100) + '%';
}
function addBusy(on) {
  adding = on;
  $('addGo').disabled = on || !$('addAudio').files[0];
  $('addCancel').disabled = on;
  for (const { key } of PICKS) $('add' + key).disabled = on;
  $('addDlg').classList.toggle('busy', on);
}
$('addBtn').addEventListener('click', () => {
  for (const pick of PICKS) { $('add' + pick.key).value = ''; renderPick(pick); }
  addSay(''); addBusy(false);
  $('addDlg').showModal();
});
$('addCancel').addEventListener('click', () => closeSheet($('addDlg')));
for (const pick of PICKS) $('add' + pick.key).addEventListener('change', () => { renderPick(pick); addBusy(false); });
$('addGo').addEventListener('click', async () => {
  const af = $('addAudio').files[0], tf = $('addText').files[0], pf = $('addPdf').files[0];
  if (!af || adding) return;
  addBusy(true);
  const id = crypto.randomUUID();
  try {
    addSay('Reading the audiobook…', 0);
    const src = await openAudio(af, (p) => addSay('Reading the audiobook…', p * 0.1));
    let doc = null;
    if (tf) { addSay('Reading the book text…', 0.1); doc = await readBook(tf); }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await store('write', id, 'audio', af, (p) => addSay('Copying the audiobook… ' + Math.round(p * 100) + '%', 0.15 + p * 0.7));
    if (src.tags.cover) await store('write', id, 'cover', src.tags.cover);
    if (doc) await storeText(id, doc);
    // A page scan that can't be used shouldn't stop the book being added.
    let pdf = null, pdfProblem = '';
    if (pf) {
      try {
        pdf = await readPdfPages(pf, (p) => addSay('Reading the page scan… ' + Math.round(p * 100) + '%', 0.85 + p * 0.15));
        await store('write', id, 'pagesrc', new Blob([JSON.stringify(pdf)], { type: 'application/json' }));
        await store('write', id, 'pagepdf', pf);
      } catch (err) { pdf = null; pdfProblem = (err && err.message) || String(err); }
    }
    const book = {
      id, fromAudio: { title: src.tags.title || '', author: src.tags.author || '' },
      fromText: doc ? { title: doc.title, author: doc.author } : {},
      audioName: af.name, kind: src.kind, duration: src.duration, chapters: src.chapters,
      hasCover: !!src.tags.cover, hasText: !!doc, textName: tf ? tf.name : '', pageCount: doc ? doc.pages.length : 0,
      position: 0, speed: 1, added: Date.now(), marks: [],
    };
    if (pdf) { book.hasPagePdf = true; book.pageSrcName = pf.name; book.pageFirst = guessFirstNumbered(pdf.pages) || 1; }
    resolveMeta(book);
    state.books.unshift(book);
    save(true);
    addBusy(false);
    closeSheet($('addDlg'));
    await openBook(id);
    if (pdfProblem) toast('Book added, but not the page scan: ' + pdfProblem);
    warmModel().catch(() => {});
  } catch (err) {
    await store('remove', id).catch(() => {});
    addBusy(false);
    addSay('Could not add this book: ' + ((err && err.message) || err));
    $('addStatus').className = 'warn';
  }
});

// ---------- player ----------
let cur = null;   // { book, source, text, audioUrl, coverUrl }
let scrubbing = false;

const chaptersOf = (b) => (b.chapters && b.chapters.length ? b.chapters : [{ start: 0, title: '' }]);
function chapterAt(b, t) {
  const ch = chaptersOf(b);
  let i = 0;
  while (i + 1 < ch.length && ch[i + 1].start <= t + 0.25) i++;
  return { i, start: ch[i].start, end: i + 1 < ch.length ? ch[i + 1].start : b.duration, title: ch[i].title, count: ch.length };
}

async function openBook(id, coverNow) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  if (cur && cur.book === book) { showPlayer(); return; }   // already loaded, maybe playing
  const file = await stored(id, 'audio');
  if (!file) { toast('The audio for this book is missing from this device'); return; }
  closeBook();
  cur = { book, source: null, text: null, meta: { toc: [], pages: [], figures: [] }, pageSrc: null, audioUrl: null, coverUrl: null };
  showPlayer();
  setScroll($('title'), book.title);
  $('author').textContent = book.author;
  $('playerError').hidden = true;
  renderInfo();
  renderSpeed();
  // Show the library's copy of the cover at once; the book's own copy replaces it when loaded.
  if (coverNow) $('cover').src = coverNow; else $('cover').removeAttribute('src');
  cur.audioUrl = URL.createObjectURL(await playable(file));
  audio.src = cur.audioUrl;
  audio.playbackRate = book.speed || 1;
  renderTime(book.position || 0);
  renderMarks(); renderTextStatus(); setMediaSession(); renderFigTab();

  const mine = cur;
  if (book.hasCover) stored(id, 'cover').then((f) => {
    if (!f || cur !== mine) return;
    mine.coverUrl = URL.createObjectURL(f);
    $('cover').src = mine.coverUrl;
    setMediaSession(); renderMini();
  });
  openAudio(file).then((s) => { if (cur === mine) { mine.source = s; runQueue(); } })
    .catch((e) => { if (cur === mine) setQueueStatus('Cannot read this audio for quotes: ' + e.message); });
  if (book.hasText) stored(id, 'text').then(async (f) => {
    if (!f || cur !== mine) return;
    const meta = await stored(id, 'meta');
    if (meta) try { mine.meta = { toc: [], pages: [], figures: [], ...JSON.parse(await meta.text()) }; } catch (e) {}
    mine.text = buildBook(await f.text());
    if (!mine.meta.tablesDone) {
      // Books added before tables written as plain lines were recognised: look for them now.
      mine.meta.figures = mine.meta.figures.filter((x) => !x.plain).concat(findTextTables(mine.text.text)).sort((x, y) => x.at - y.at);
      mine.meta.tablesDone = true;
      for (const m of book.marks) delete m.figs;   // figure numbers have shifted
      store('write', id, 'meta', new Blob([JSON.stringify(mine.meta)], { type: 'application/json' })).catch(() => {});
    }
    renderFigTab();
    rematch(); runQueue(); renderInfo();
  });
  if (book.pageSrcName) stored(id, 'pagesrc').then(async (f) => {
    if (!f || cur !== mine) return;
    try {
      const src = JSON.parse(await f.text());
      mine.pageSrc = { labels: src.labels, count: src.pages.length, index: buildPageIndex(src.pages) };
      findPages(); renderInfo();
    } catch (e) { /* unreadable page source: carry on without it */ }
  });
}

// Animates a change of screen. The browser takes a picture before and after
// `update` and blends them; elements that share a name in both pictures (the
// cover, the bottom bar) glide from their old place and size to the new one.
// `fromCover` is a library thumbnail to treat as the cover for this change.
function morph(update, fromCover) {
  if (!document.startViewTransition || calm.matches) return update();
  const mini = $('miniCover');
  if (fromCover) { fromCover.style.viewTransitionName = 'cover'; mini.style.viewTransitionName = 'none'; }
  const reset = () => { if (fromCover) fromCover.style.viewTransitionName = ''; mini.style.viewTransitionName = ''; };
  let t;
  try { t = document.startViewTransition(async () => { await update(); reset(); }); } catch (e) { reset(); return update(); }
  t.ready.catch((e) => log('screen animation skipped: ' + ((e && e.message) || e)));
  t.finished.catch(() => {}).then(reset);
}

// The two screens. Going to the library leaves the book loaded and playing,
// with a mini player along the bottom.
function showPlayer() {
  $('library').hidden = true; $('player').hidden = false;
  $('tabbar').hidden = false; $('libFoot').hidden = true; document.body.classList.add('has-bar');
  renderMini();
  window.scrollTo(0, 0);
  refitScrolls();
}
function showLibrary() {
  $('player').hidden = true; $('library').hidden = false;
  $('tabbar').hidden = true; $('libFoot').hidden = false; document.body.classList.remove('has-bar');
  renderLibrary(); renderMini();
  window.scrollTo(0, 0);
  refitScrolls();
}

function closeBook() {
  if (!cur) return;
  setSleep(null);
  trackLast = null; pendingFigure = null; reached.clear();
  wantPlaying = false; clearTimeout(playCheck);
  audio.pause();
  keepAlive(false);
  cur.book.position = audio.currentTime || cur.book.position || 0;
  save(true);
  audio.removeAttribute('src'); audio.load();
  if (cur.audioUrl) URL.revokeObjectURL(cur.audioUrl);
  if (cur.coverUrl) URL.revokeObjectURL(cur.coverUrl);
  cur = null;
  renderMini();
}
$('backBtn').addEventListener('click', () => morph(showLibrary));

// Swipe down on the player to return to the library. The player stays solid
// and slides down with the finger, uncovering the library, which fades in
// underneath. Past a third of the screen, or with a quick flick, it goes
// back; otherwise it settles. The scrubber and other sliders are left alone.
{
  const player = $('player'), under = [$('library'), $('libFoot')];
  let g = null;
  // Put the library behind the player (or take it away again) for the drag.
  const uncover = (on) => {
    for (const n of under) { n.hidden = !on; n.style.opacity = on ? '0' : ''; }
    if (on) renderLibrary();
    renderMini();
  };
  const clear = () => { player.style.transition = ''; player.style.transform = ''; player.classList.remove('lifted'); };
  const settle = () => {
    player.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.85, 0.25, 1)';
    player.style.transform = '';
    for (const n of under) { n.style.transition = 'opacity 0.2s'; n.style.opacity = '0'; }
    setTimeout(() => {
      clear();
      for (const n of under) n.style.transition = '';
      if (!player.hidden) uncover(false);     // still on the player: hide the library again
    }, 240);
  };
  player.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || window.scrollY > 0 || e.target.closest('input, select, textarea')) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, dy: 0, dragging: false };
  }, { passive: true });
  player.addEventListener('touchmove', (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { g = null; return; }
      g.dragging = true;
      player.style.transition = 'none';
      player.classList.add('lifted');
      uncover(true);
    }
    if (e.cancelable) e.preventDefault();
    g.dy = Math.max(0, dy);
    player.style.transform = 'translateY(' + g.dy + 'px)';
    const shown = String(Math.min(1, g.dy / (window.innerHeight * 0.45)));
    for (const n of under) n.style.opacity = shown;
  }, { passive: false });
  const release = (e) => {
    const was = g;
    g = null;
    if (!was || !was.dragging) return;
    const speed = was.dy / Math.max(1, e.timeStamp - was.at);
    if (e.type === 'touchend' && (was.dy > window.innerHeight / 3 || (speed > 0.5 && was.dy > 40))) {
      // From where it was let go, the player shrinks into the mini player.
      morph(() => { clear(); for (const n of under) n.style.opacity = ''; showLibrary(); });
    } else settle();
  };
  player.addEventListener('touchend', release);
  player.addEventListener('touchcancel', release);
}

// ---------- mini player (library screen) ----------
function renderMini() {
  const show = !!cur && !$('library').hidden;
  $('mini').hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (!show) return;
  const b = cur.book, t = audio.currentTime || b.position || 0, c = chapterAt(b, t);
  setScroll($('miniTitle'), b.title);
  $('miniTime').textContent = fmt(t) + (c.count > 1 ? ' · ' : '');
  setScroll($('miniChap'), c.count > 1 ? c.title : '');
  $('miniCover').hidden = !cur.coverUrl;
  if (cur.coverUrl && $('miniCover').getAttribute('src') !== cur.coverUrl) $('miniCover').src = cur.coverUrl;
  $('miniFill').style.width = (100 * t / (b.duration || 1)) + '%';
}
$('miniOpen').addEventListener('click', () => morph(showPlayer));
$('miniMark').addEventListener('click', () => addMark());
$('miniPlay').addEventListener('click', () => {
  log('screen: ' + (audio.paused ? 'play' : 'pause') + ' (mini player)');
  if (audio.paused) play(); else pause();
});

// ---------- sleep timer ----------
// Either a clock time to stop at, or a position in the book (end of chapter).
let sleep = null, sleepTick = null;
function setSleep(next) {
  sleep = next;
  clearInterval(sleepTick);
  if (sleep) sleepTick = setInterval(checkSleep, 1000);
  renderSleep();
}
function checkSleep() {
  if (!sleep || !cur) return;
  const due = sleep.at ? Date.now() >= sleep.at : audio.currentTime >= sleep.end - 0.4;
  if (!due) { renderSleep(); return; }
  log('sleep timer: pausing');
  setSleep(null);
  if (!audio.paused) { pause(); toast('Sleep timer: paused'); }
}
function renderSleep() {
  const label = !sleep ? '' : sleep.at ? fmt(Math.max(0, (sleep.at - Date.now()) / 1000)) : 'chapter';
  $('sleepLabel').textContent = label;
  $('sleepBtn').classList.toggle('on', !!sleep);
  $('sleepBtn').setAttribute('aria-label', sleep ? 'Sleep timer, ' + (sleep.at ? label + ' left' : 'end of chapter') : 'Sleep timer');
}
$('sleepBtn').addEventListener('click', () => {
  const ol = $('sleepList');
  ol.textContent = '';
  const add = (text, value, current) => {
    const btn = el('button');
    btn.append(el('span', '', text));
    if (current) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      setSleep(value);
      if (value) log('sleep timer: ' + text);
      closeSheet($('sleepDlg'));
    });
    const li = el('li'); li.append(btn); ol.append(li);
  };
  add('Off', null, !sleep);
  for (const m of [5, 10, 15, 30, 45, 60]) add(m + ' minutes', { at: Date.now() + m * 60000, mins: m }, !!sleep && sleep.mins === m);
  const c = chapterAt(cur.book, audio.currentTime);
  add(c.count > 1 ? 'End of chapter' : 'End of book', { end: c.end }, !!sleep && sleep.end != null);
  $('sleepDlg').showModal();
});
$('sleepClose').addEventListener('click', () => closeSheet($('sleepDlg')));

audio.addEventListener('loadedmetadata', () => {
  if (!cur) return;
  const p = cur.book.position || 0;
  if (p > 0 && p < audio.duration - 1) audio.currentTime = p;
  updatePositionState();
});
audio.addEventListener('timeupdate', () => {
  if (!cur || audio.readyState < 1) return;
  cur.book.position = audio.currentTime;
  save();
  if (!scrubbing) renderTime(audio.currentTime);
  if (!$('mini').hidden) renderMini();
  if (sleep && sleep.end != null) checkSleep();
  trackFigures();
});
audio.addEventListener('error', () => {
  // Unloading the previous book can raise a stray error; only a real one for this book counts.
  if (!cur || !audio.error || audio.getAttribute('src') !== cur.audioUrl) return;
  const e = audio.error;
  $('playerError').hidden = false;
  $('playerError').textContent = 'This file cannot be played here (code ' + (e ? e.code : '?') + (e && e.message ? ': ' + e.message : '') + ').';
  toast('This file cannot be played here');
});
const PLAY = 'M8 5v14l11-7z', PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
function syncPlayState() {
  const playing = !audio.paused;
  $('playIcon').setAttribute('d', playing ? PAUSE : PLAY);
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('miniPlayIcon').setAttribute('d', playing ? PAUSE : PLAY);
  $('miniPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (!playing && cur) save(true);
}
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', syncPlayState);
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('seeked', updatePositionState);
audio.addEventListener('seeked', () => { trackLast = null; });
document.addEventListener('visibilitychange', () => {
  log('page ' + document.visibilityState);
  showPendingFigure();
  if (document.visibilityState === 'visible' && wantPlaying && cur) {
    const from = audio.currentTime;
    setTimeout(() => { if (wantPlaying && cur && (audio.paused || audio.currentTime === from)) unstick(); }, 700);
  }
  if (document.visibilityState === 'hidden') { if (cur) save(true); }
  runQueue();
});

// Whole-book progress: a pie, the percentage, and the listening time left at
// the current speed.
function renderOverall(t) {
  const b = cur.book, frac = Math.max(0, Math.min(1, t / (b.duration || 1)));
  const left = Math.max(0, b.duration - t) / (b.speed || 1);
  const mins = Math.round(left / 60), h = Math.floor(mins / 60), m = mins % 60;   // whole minutes first, so 59.6 min is 1h 0m, not 0h 60m
  const leftText = left < 30 ? 'finished' : (h ? h + 'h ' : '') + (mins ? m + 'm' : '<1m') + ' left';
  $('pie').style.setProperty('--p', (frac * 100).toFixed(1));
  $('overallText').textContent = Math.floor(frac * 100) + '% · ' + leftText;
  $('overall').setAttribute('aria-label', Math.floor(frac * 100) + ' percent of the book, ' + leftText);
}

function renderTime(t) {
  const b = cur.book, c = chapterAt(b, t);
  const label = c.count > 1 ? c.title : 'Whole book';
  setScroll($('chapterText'), label);
  $('chapterBtn').disabled = c.count <= 1;
  const s = $('scrub');
  s.min = Math.floor(c.start); s.max = Math.max(Math.floor(c.start) + 1, Math.ceil(c.end)); s.value = t; fillRange(s);
  $('elapsed').textContent = fmt(t - c.start);
  $('remaining').textContent = '−' + fmt(c.end - t);
  renderOverall(t);
}
function seek(t) {
  if (!cur) return;
  t = Math.max(0, Math.min(cur.book.duration - 0.5, t));
  cur.book.position = t;
  try { audio.currentTime = t; } catch (e) {}
  renderTime(t);
}
$('scrub').addEventListener('input', () => {
  scrubbing = true;
  const t = Number($('scrub').value), c = chapterAt(cur.book, audio.currentTime);
  $('elapsed').textContent = fmt(t - c.start);
  $('remaining').textContent = '−' + fmt(c.end - t);
  renderOverall(t);
});
$('scrub').addEventListener('change', () => { scrubbing = false; seek(Number($('scrub').value)); });
// ---------- keeping the audio session alive ----------
// Installed to the home screen, iOS will not let the app restart audio from
// the lock screen once it has fully paused: the player reports "playing" but
// stays silent until the app is opened. Playing a silent loop alongside keeps
// the audio session open across a pause, so play works again from the lock
// screen. It stops itself after a while so a forgotten pause costs no battery.
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const KEEP_ALIVE_MS = 15 * 60 * 1000;
let keep = null, keepTimer = null, keepOn = false;
function silentWav(seconds) {
  const rate = 8000, n = rate * seconds, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, t) => { for (let k = 0; k < t.length; k++) v.setUint8(o + k, t.charCodeAt(k)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return new Blob([buf], { type: 'audio/wav' });
}
function keepAlive(on) {
  clearTimeout(keepTimer);
  if (!standalone) return;
  if (on) {
    if (!keep) { keep = new Audio(URL.createObjectURL(silentWav(10))); keep.loop = true; }
    if (keepOn && !keep.paused) return;
    keepOn = true;
    keep.play().then(() => log('keep-alive: on'), (e) => { keepOn = false; log('keep-alive failed: ' + e.name); });
  } else if (keepOn) {
    keepOn = false;
    keep.pause();
    log('keep-alive: off');
  }
}

// ---------- sounds ----------
// Short tones that confirm an action when the phone is out of sight: two
// rising notes for a bookmark, a quick up or down pair for skipping forward
// or back, three notes at a picture or table. They play through their own
// small audio elements alongside the book.
const SOUNDS = {
  mark: [[880, 70], [1320, 120]],
  fwd: [[700, 45], [1050, 55]],
  back: [[1050, 45], [700, 55]],
  figure: [[660, 90], [880, 90], [1100, 150]],
};
function toneWav(notes) {
  const rate = 22050, gap = 0.03;
  const total = notes.reduce((sum, [, ms]) => sum + ms / 1000 + gap, 0);
  const n = Math.ceil(rate * total), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => { for (let k = 0; k < t.length; k++) v.setUint8(o + k, t.charCodeAt(k)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let at = 0;
  for (const [freq, ms] of notes) {
    const len = Math.floor(rate * ms / 1000);
    for (let k = 0; k < len; k++) {
      const env = Math.min(1, k / 200, (len - k) / 400);   // soft start and end, so no clicks
      v.setInt16(44 + (at + k) * 2, Math.round(Math.sin(2 * Math.PI * freq * k / rate) * env * 0.3 * 32767), true);
    }
    at += len + Math.floor(rate * gap);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
const fx = {};
let fxReady = false;
// iOS only lets a page start sound it has already started once from a tap,
// so each tone is played silently the first time the user presses play.
function primeSounds() {
  if (fxReady || !settings.sounds) return;
  fxReady = true;
  for (const key of Object.keys(SOUNDS)) {
    const a = fx[key] || (fx[key] = new Audio(URL.createObjectURL(toneWav(SOUNDS[key]))));
    a.preload = 'auto'; a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }, () => { a.muted = false; fxReady = false; });
  }
}
function sound(key) {
  const a = fx[key];
  if (!settings.sounds || !a) return;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play();
  if (p) p.catch((e) => log('sound "' + key + '" did not play: ' + e.name));
}

// Starts playback, and checks a few seconds later that audio is really
// moving. Safari can report "playing" while nothing comes out.
let wantPlaying = false, playCheck = null;
function play(isRetry) {
  if (!cur) return;
  wantPlaying = true;
  keepAlive(true);
  primeSounds();
  const from = audio.currentTime;
  const p = audio.play();
  if (p) p.catch((e) => { log('play() refused: ' + e.name + ': ' + e.message); if (!isRetry) toast('Cannot play: ' + e.message); });
  clearTimeout(playCheck);
  playCheck = setTimeout(() => {
    if (!cur || !wantPlaying) return;
    if (!audio.paused && audio.currentTime !== from) return;   // playing normally
    log('playback is not moving (paused=' + audio.paused + ', readyState=' + audio.readyState + ', networkState=' + audio.networkState
      + ', error=' + (audio.error ? audio.error.code : 'none') + ')');
    // Locked, there is nothing more to try; unstick() runs when the app is next on screen.
    if (document.visibilityState === 'hidden' || isRetry) return;
    unstick();
  }, 2500);
}
// What works by hand when audio is stuck: pause, then play again.
function unstick() {
  if (!cur || !wantPlaying) return;
  log('restarting stuck playback');
  audio.pause();
  play(true);
}
function pause() {
  wantPlaying = false;
  clearTimeout(playCheck);
  audio.pause();
  if (keepOn) keepTimer = setTimeout(() => keepAlive(false), KEEP_ALIVE_MS);
}
$('playBtn').addEventListener('click', () => {
  log('screen: ' + (audio.paused ? 'play' : 'pause'));
  if (audio.paused) play(); else pause();
});
for (const ev of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'emptied', 'loadedmetadata']) {
  audio.addEventListener(ev, () => log('audio: ' + ev + ' at ' + fmt(audio.currentTime) + ' (ready ' + audio.readyState + ')'));
}
$('backward').addEventListener('click', () => seek(audio.currentTime - settings.skipBack));
$('forward').addEventListener('click', () => seek(audio.currentTime + settings.skipFwd));

// Runs whatever a track button is set to do.
function runAction(cfg) {
  if (!cur) return;
  const t = audio.currentTime, c = chapterAt(cur.book, t), ch = chaptersOf(cur.book);
  switch (cfg.action) {
    case 'mark': addMark(); break;
    case 'fwd': seek(t + cfg.secs); sound('fwd'); break;
    case 'back': seek(t - cfg.secs); sound('back'); break;
    case 'nextChapter': if (c.i + 1 < ch.length) seek(ch[c.i + 1].start); break;
    // Like a music player: first press returns to the chapter start.
    case 'prevChapter': seek(t - c.start > 3 || c.i === 0 ? c.start : ch[c.i - 1].start); break;
  }
}
const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
function renderSpeed() {
  const v = (cur && cur.book.speed) || 1;
  $('speedLabel').textContent = v + '×';
  $('speedBtn').setAttribute('aria-label', 'Playback speed, ' + v + ' times');
  $('speedBtn').classList.toggle('on', v !== 1);
}
$('speedBtn').addEventListener('click', () => {
  const ol = $('speedList'), now = cur.book.speed || 1;
  ol.textContent = '';
  for (const v of SPEEDS) {
    const btn = el('button');
    btn.append(el('span', '', v + '×' + (v === 1 ? '  (normal)' : '')));
    if (v === now) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      cur.book.speed = v; audio.playbackRate = v;
      save(true); renderSpeed(); renderOverall(audio.currentTime || cur.book.position || 0);
      closeSheet($('speedDlg'));
    });
    const li = el('li'); li.append(btn); ol.append(li);
  }
  $('speedDlg').showModal();
});
$('speedClose').addEventListener('click', () => closeSheet($('speedDlg')));

// chapters
$('chapterBtn').addEventListener('click', () => {
  const b = cur.book, now = chapterAt(b, audio.currentTime).i, ol = $('chapList');
  ol.textContent = '';
  let current = null;
  chaptersOf(b).forEach((ch, i) => {
    const btn = el('button');
    btn.append(el('span', '', ch.title), el('span', '', fmt(ch.start)));
    if (i === now) { btn.setAttribute('aria-current', 'true'); current = btn; }
    btn.addEventListener('click', () => { seek(ch.start); closeSheet($('chapDlg')); });
    const li = el('li'); li.append(btn); ol.append(li);
  });
  $('chapDlg').showModal();
  if (current) current.scrollIntoView({ block: 'center' });
});
$('chapClose').addEventListener('click', () => closeSheet($('chapDlg')));

// ---------- lock screen, headphone and watch buttons ----------
function setMediaSession() {
  if (!('mediaSession' in navigator) || !cur) return;
  const ms = navigator.mediaSession, b = cur.book;
  if (window.MediaMetadata) {
    ms.metadata = new MediaMetadata({
      title: b.title, artist: b.author, album: 'Bork Mark',
      artwork: cur.coverUrl ? [{ src: cur.coverUrl, sizes: '512x512' }] : [],
    });
  }
  const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) {} };
  on('play', () => { log('button: play'); play(); });
  on('pause', () => {
    // With the silent loop running, iOS can show "pause" while the book is
    // already paused; pressing it then means play.
    if (audio.paused && keepOn) { log('button: pause (book already paused, so play)'); play(); return; }
    log('button: pause'); pause();
  });
  // With seek handlers set, the lock screen shows skip buttons, while a watch
  // or headset still sends next / previous.
  on('seekbackward', settings.lockSeek ? () => { log('button: skip back'); seek(audio.currentTime - settings.skipBack); sound('back'); } : null);
  on('seekforward', settings.lockSeek ? () => { log('button: skip forward'); seek(audio.currentTime + settings.skipFwd); sound('fwd'); } : null);
  on('nexttrack', settings.next.action === 'none' ? null : () => { log('button: next track -> ' + settings.next.action); runAction(settings.next); });
  on('previoustrack', settings.prev.action === 'none' ? null : () => { log('button: previous track -> ' + settings.prev.action); runAction(settings.prev); });
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration),
    });
  } catch (e) {}
}

// ---------- bookmarks ----------
let lastMarkAt = 0;
function addMark() {
  if (!cur) return;
  const now = Date.now();
  if (now - lastMarkAt < MERGE_WINDOW) return;
  lastMarkAt = now;
  const t = audio.currentTime || cur.book.position || 0;
  cur.book.marks.unshift({ id: crypto.randomUUID(), t, created: now, status: 'pending' });
  sound('mark');
  save(true);
  renderMarks();
  toast('Bookmarked ' + fmt(t));
  $('markBtn').classList.add('flash');
  setTimeout(() => $('markBtn').classList.remove('flash'), 180);
  runQueue();
}
$('markBtn').addEventListener('click', addMark);

const expanded = new Set();
// Shorten text to roughly n characters without cutting a word.
const tail = (str, n) => (str.length <= n ? str : '…' + str.slice(str.indexOf(' ', str.length - n) + 1));
const head = (str, n) => (str.length <= n ? str : str.slice(0, str.lastIndexOf(' ', n)) + '…');

const STATUS = {
  pending: 'waiting', working: 'finding quote…', transcribed: 'heard, no book text',
  nomatch: 'not found in text', error: 'failed',
};

function renderMarks() {
  if (!cur) return;
  const b = cur.book, ol = $('marks');
  ol.textContent = '';
  const n = b.marks.length, waiting = b.marks.filter((m) => m.status === 'pending' || m.status === 'working').length;
  $('markCount').textContent = n ? '(' + n + ')' : '';
  $('marksLabel').textContent = n ? String(n) : '';
  $('marksBtn').setAttribute('aria-label', 'Bookmarks' + (n ? ', ' + n : '') + (waiting ? ', ' + waiting + ' still being processed' : ''));
  $('marksBtn').classList.toggle('on', waiting > 0);
  if (!b.marks.length) {
    ol.append(el('li', 'muted', 'None yet. Press Bookmark, or next / previous track on your headphones or watch.'));
    return;
  }
  for (const m of b.marks) {
    const li = el('li', 'mark');
    const top = el('div', 'markhead');
    top.append(el('span', 'when', fmt(m.t)));
    const c = chapterAt(b, m.t);
    if (c.count > 1) top.append(el('span', 'muted', c.title));
    if (STATUS[m.status]) top.append(el('span', 'chip', STATUS[m.status]));
    li.append(top);
    let extra = null;

    if (m.status === 'done') {
      // Collapsed, a card shows just the text around the bookmark point.
      const q = el('div', 'quote');
      const open = expanded.has(m.id);
      const before = open ? m.before : tail(m.before, 220), after = open ? m.after : head(m.after, 120);
      q.append(document.createTextNode(before), el('span', 'pin', '🔖'), document.createTextNode(after));
      li.append(q);
      if (before !== m.before || after !== m.after || open) {
        const more = el('button', 'small', open ? 'Less' : 'More');
        more.addEventListener('click', () => { if (open) expanded.delete(m.id); else expanded.add(m.id); renderMarks(); });
        extra = more;
      }
    } else if (m.transcript) {
      li.append(el('div', 'quote raw', m.transcript));
    } else if (m.status === 'error') {
      li.append(el('div', 'warn', m.error || 'Something went wrong.'));
    }

    if (m.status === 'done' && (m.section || m.page)) {
      li.append(el('div', 'muted cite', [m.section, m.page && 'p. ' + m.page].filter(Boolean).join(' · ')));
    }
    const actions = el('div', 'row');
    if (extra) actions.append(extra);
    const play = el('button', 'small', 'Play');
    play.addEventListener('click', () => { seek(m.t - 30); play(); closeSheet($('marksDlg')); });
    actions.append(play);
    if (m.status === 'done' || m.transcript) {
      const copy = el('button', 'small', 'Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(shareText(b, m)); toast('Copied'); } catch (e) { toast('Copy failed'); }
      });
      actions.append(copy);
      if (navigator.share) {   // the system share sheet: Are.na, Notes, Messages…
        const share = el('button', 'small', 'Share');
        share.addEventListener('click', () => {
          navigator.share({ text: shareText(b, m) }).catch((e) => { if (e.name !== 'AbortError') toast('Could not share'); });
        });
        actions.append(share);
      }
    }
    for (const i of (m.status === 'done' && m.figs) || []) {
      const f = cur.meta.figures[i];
      if (!f) continue;
      const view = el('button', 'small', f.kind === 'table' ? 'Table' : 'Picture');
      view.setAttribute('aria-label', (f.kind === 'table' ? 'Table: ' : 'Picture: ') + (f.cap || 'no caption'));
      view.addEventListener('click', () => openFigure(i));
      actions.append(view);
    }
    if (m.status === 'done' && m.pdfPage != null && b.hasPagePdf) {
      const page = el('button', 'small', 'Page');
      page.setAttribute('aria-label', 'Show the scanned page');
      page.addEventListener('click', () => { if (cur.pageSrc) showPdfPage(m.pdfPage); else toast('The page scan is still loading'); });
      actions.append(page);
    }
    if (m.status === 'error') {
      const retry = el('button', 'small', 'Retry');
      retry.addEventListener('click', () => { m.status = 'pending'; delete m.error; save(true); renderMarks(); runQueue(); });
      actions.append(retry);
    }
    const del = el('button', 'small', 'Delete');
    del.addEventListener('click', () => {
      if (!confirm('Delete the bookmark at ' + fmt(m.t) + '?')) return;
      b.marks = b.marks.filter((x) => x !== m);
      save(true); renderMarks();
    });
    actions.append(del);
    li.append(actions);
    ol.append(li);
  }
}

// ---------- speech-to-text worker ----------
let asrWorker = null, asrSeq = 0, modelState = 'idle';   // idle | loading | ready | failed
const asrJobs = new Map();
function asrRequest(pcm) {
  if (!asrWorker) {
    asrWorker = new Worker('./align-worker.js', { type: 'module' });
    asrWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress' && m.total) {
        setQueueStatus('Downloading the speech model (one time): ' + Math.round(100 * m.loaded / m.total) + '%');
        return;
      }
      const job = asrJobs.get(m.id);
      if (!job) return;
      asrJobs.delete(m.id);
      if (m.type === 'done') job.resolve(m); else job.reject(new Error(m.message));
    };
    asrWorker.onerror = (e) => {
      for (const job of asrJobs.values()) job.reject(new Error(e.message || 'speech model failed to start'));
      asrJobs.clear();
      asrWorker = null; modelState = 'idle';
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++asrSeq;
    asrJobs.set(id, { resolve, reject });
    asrWorker.postMessage({ id, audio: pcm || null, model: MODEL, device: 'wasm' }, pcm ? [pcm.buffer] : []);
  });
}
const transcribe = (pcm) => asrRequest(pcm);

// Loads the speech model ahead of time, so the first bookmark doesn't have
// to do it in the middle of playback.
let warming = null;
function warmModel() {
  if (modelState === 'ready') return Promise.resolve();
  if (warming) return warming;
  modelState = 'loading';
  crumb('loading the speech model');
  setQueueStatus('Getting the speech model ready…');
  warming = asrRequest(null).then(() => {
    modelState = 'ready';
  }, (err) => {
    modelState = 'failed';
    setQueueStatus('Speech model could not load: ' + err.message);
    throw err;
  }).finally(() => {
    warming = null; crumb(null);
    if (modelState === 'ready') setQueueStatus('');
    renderModelNote();
  });
  renderModelNote();
  return warming;
}

function setQueueStatus(msg) {
  $('queueStatus').textContent = msg;
  $('modelNote').textContent = msg || (modelState === 'ready' ? 'Speech model ready.' : '');
}
function renderModelNote() { setQueueStatus($('queueStatus').textContent); }

function applyQuote(m, text) {
  const loc = findInBook(text, m.words, m.split);
  if (!loc) { m.status = 'nomatch'; return; }
  // The place in the book is kept, so the quote can be re-cut if the capture setting changes.
  m.status = 'done'; m.loc = [loc.start, loc.split, loc.end]; m.confidence = loc.confidence;
  requote(m, text);
  delete m.words; delete m.split; delete m.transcript;
}
function requote(m, text) {
  const q = quoteAt(text, { start: m.loc[0], split: m.loc[1], end: m.loc[2] }, settings.capture);
  m.before = q.before; m.after = q.after;
  // Where in the book this is, for citing: its contents entry and print page.
  if (cur && cur.text === text && text.starts.length) {
    const at = text.starts[Math.min(m.loc[1], text.starts.length - 1)];
    const section = entryAt(cur.meta.toc, at), page = entryAt(cur.meta.pages, at);
    m.section = section ? section.label : ''; m.page = page ? page.label : '';
  }
  if (cur && cur.text === text && text.starts.length) {   // pictures and tables that fall inside the quote
    const at = text.starts[Math.min(m.loc[1], text.starts.length - 1)];
    const from = at - m.before.length - 40, to = at + m.after.length + 40;
    m.figs = cur.meta.figures.map((f, i) => (f.at >= from && f.at <= to ? i : -1)).filter((i) => i >= 0).slice(0, 6);
  }
  if (cur && cur.pageSrc) {   // a scanned edition, when added, decides the page
    m.pdfPage = pageOf(cur.pageSrc.index, m.before, m.after);
    if (m.pdfPage != null) m.page = pageLabel(cur.book, cur.pageSrc, m.pdfPage);
  }
}
// ---------- page numbers from a scanned PDF ----------
// The printed page number for a PDF page (counted from 0): the PDF's own
// label if it has them, otherwise counted from the page set as "page 1".
function pageLabel(b, src, i) {
  if (src.labels) return src.labels[i] || '';
  const n = i + 1 - ((b.pageFirst || 1) - 1);
  return n >= 1 ? String(n) : '';
}
// Looks up quotes in the scan. Quotes it can't place keep whatever page they had.
function findPages(onlyMissing) {
  if (!cur || !cur.pageSrc) return 0;
  let found = 0;
  for (const m of cur.book.marks) {
    if (m.status !== 'done') continue;
    if (!(onlyMissing && m.pdfPage != null)) m.pdfPage = pageOf(cur.pageSrc.index, m.before, m.after);
    if (m.pdfPage != null) { m.page = pageLabel(cur.book, cur.pageSrc, m.pdfPage); found++; }
  }
  save(true); renderMarks();
  return found;
}

// Author, Title, “Chapter”, p. 12 (audiobook, 1:23:45)
function citation(b, m) {
  const c = chapterAt(b, m.t), where = m.section || (c.count > 1 ? c.title : '');
  return [b.author, b.title, where && '“' + where + '”', m.page && 'p. ' + m.page].filter(Boolean).join(', ')
    + ' (audiobook, ' + fmt(m.t) + ')';
}
const shareText = (b, m) => (m.status === 'done' ? '“' + (m.before + m.after).trim() + '”' : m.transcript) + '\n\n— ' + citation(b, m);
function requoteAll() {
  if (!cur || !cur.text) return;
  for (const m of cur.book.marks) if (m.status === 'done' && m.loc) requote(m, cur.text);
  save(true); renderMarks();
}

// Bookmarks transcribed before the book text was available can be matched
// now without listening to the audio again.
function rematch() {
  if (!cur || !cur.text) return;
  let changed = false;
  for (const m of cur.book.marks) {
    if ((m.status === 'transcribed' || m.status === 'nomatch') && m.words) { applyQuote(m, cur.text); changed = true; }
  }
  if (changed) { save(true); renderMarks(); }
}

let queueBusy = false;
async function runQueue() {
  if (queueBusy || naming || probing || !cur || !cur.source || !canWork()) return;
  if (cur.book.hasText && !cur.text) return;   // text still loading
  queueBusy = true;
  const mine = cur;
  try {
    for (;;) {
      if (cur !== mine || !canWork()) break;
      const m = [...mine.book.marks].reverse().find((x) => x.status === 'pending');
      if (!m) break;
      // Saved before starting, so a crash here is not retried automatically.
      m.status = 'working'; save(true); renderMarks();
      try {
        await warmModel();
        setQueueStatus('Finding quotes…');
        const r = await transcribeAround(mine.source, m.t,
          settings.capture.mode === 'time' ? settings.capture.before : LOCATE_BEFORE,
          settings.capture.mode === 'time' ? settings.capture.after : LOCATE_AFTER, transcribe, crumb);
        m.words = r.words; m.split = r.split; m.transcript = r.transcript;
        if (mine.text) applyQuote(m, mine.text); else m.status = 'transcribed';
      } catch (err) {
        m.status = 'error'; m.error = String((err && err.message) || err);
      }
      crumb(null);
      save(true);
      if (cur === mine) renderMarks();
    }
  } finally {
    queueBusy = false;
    crumb(null);
    if (modelState !== 'failed') setQueueStatus('');
  }
}

// ---------- looking at a picture, table or scanned page ----------
let viewUrl = null;
function showViewer(title, node, figure) {
  if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = null; }
  $('viewTitle').textContent = title;
  $('viewBody').replaceChildren(node);
  // For a figure from the book text: jump the audio to it, or see it on the scanned page.
  const tools = $('viewTools');
  tools.textContent = '';
  if (figure != null) {
    const go = el('button', 'small', 'Go to this in the audio');
    go.addEventListener('click', () => jumpToFigure(figure));
    tools.append(go);
    if (cur.pageSrc && cur.book.hasPagePdf) {
      const scan = el('button', 'small', 'Scanned page');
      scan.addEventListener('click', () => {
        const f = cur.meta.figures[figure], t = cur.text.text;
        const i = pageOf(cur.pageSrc.index, t.slice(Math.max(0, f.at - 500), f.at), t.slice(f.at, f.at + 400));
        if (i == null) toast('Could not find this in the page scan'); else showPdfPage(i);
      });
      tools.append(scan);
    }
  }
  $('viewStatus').textContent = '';
  if (!$('viewDlg').open) $('viewDlg').showModal();
  $('viewDlg').scrollTop = 0;
}
const figureName = (f, i) => f.cap || (f.kind === 'table' ? 'Table' : 'Picture') + ' ' + (i + 1);
async function openFigure(i) {
  if (!cur) return;
  const f = cur.meta.figures[i];
  if (!f) return;
  if (f.kind === 'table') {
    const table = el('table', 'figtable');
    f.rows.forEach((cells, r) => {
      const tr = el('tr');
      for (const c of cells) {
        const cell = el(r === 0 ? 'th' : 'td', '', c);
        if (cells.length === 1) cell.colSpan = 12;   // a note that runs across the table
        tr.append(cell);
      }
      table.append(tr);
    });
    const wrap = el('div', 'figscroll'); wrap.append(table);
    showViewer(f.plain ? 'Table' : figureName(f, i), wrap, i);
    return;
  }
  const file = await stored(cur.book.id, 'img-' + f.img);
  if (!file) { toast('That picture is not stored on this device'); return; }
  const img = el('img', 'figimg');
  img.alt = f.cap || '';
  showViewer(figureName(f, i), img, i);
  viewUrl = URL.createObjectURL(file);
  img.src = viewUrl;
}
// Shows one page of the scan (counting from 0).
async function showPdfPage(index) {
  const mine = cur, file = await stored(mine.book.id, 'pagepdf');
  if (!file) { toast('The page scan is not stored on this device'); return; }
  const label = pageLabel(mine.book, mine.pageSrc, index);
  showViewer((label ? 'Page ' + label : 'Scanned page') + ' · ' + mine.book.pageSrcName, el('p', 'muted', 'Drawing the page…'));
  try {
    const canvas = await renderPdfPage(file, index + 1);
    canvas.className = 'figimg';
    if (cur === mine && $('viewDlg').open) $('viewBody').replaceChildren(canvas);
  } catch (err) {
    if ($('viewDlg').open) $('viewBody').replaceChildren(el('p', 'warn', 'Could not draw that page: ' + ((err && err.message) || err)));
  }
}
$('viewClose').addEventListener('click', () => closeSheet($('viewDlg')));

// ---------- knowing where the narration is in the text ----------
// To chime or pause at a picture, the app has to know which part of the text
// is being read. It keeps "anchors", moments where audio time and text
// position are both known: every bookmark that found its quote is one, and
// while this feature is on the app also listens to a few seconds of the book
// now and then to add more. Between anchors it assumes a steady reading pace.
function anchorList() {
  const b = cur.book, starts = cur.text.starts, list = (b.anchors || []).map(([t, at]) => ({ t, at }));
  for (const m of b.marks) if (m.loc && starts.length) list.push({ t: m.t, at: starts[Math.min(m.loc[1], starts.length - 1)] });
  return list.sort((x, y) => x.t - y.t);
}
// Characters of text read per second of audio around time t. Taken from the
// nearest pair of anchors when there is one; otherwise from the whole book if
// that gives a believable figure, and failing that an ordinary reading speed.
function pace(list, t) {
  let best = null;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], z = list[i], rate = (z.at - a.at) / (z.t - a.t);
    if (z.t - a.t < 20 || !(rate > 6 && rate < 40)) continue;
    const far = Math.min(Math.abs(a.t - t), Math.abs(z.t - t));
    if (!best || far < best.far) best = { far, rate };
  }
  if (best) return best.rate;
  const whole = cur.text.text.length / (cur.book.duration || 1);
  return whole > 9 && whole < 25 ? whole : 15;
}
function textAt(t, list) {
  if (!list.length) return null;
  let lo = null, hi = null;
  for (const a of list) { if (a.t <= t) lo = a; else { hi = a; break; } }
  if (lo && hi) {
    const rate = (hi.at - lo.at) / (hi.t - lo.t);
    if (rate > 6 && rate < 40) return lo.at + (t - lo.t) * rate;
  }
  // Outside the anchors, or between two that disagree: carry on from the nearer one.
  const a = !hi || (lo && t - lo.t <= hi.t - t) ? lo : hi;
  return a.at + (t - a.t) * pace(list, t);
}

const PROBE_EVERY = 300;      // seconds of audio allowed between anchors in normal listening
const PROBE_NEAR = 40;        // …and when a figure is coming up within the next 90 seconds
let probing = false, probeRest = 0;

// The audio time at which a place in the text is read, judged from the anchors.
function timeAt(at, list) {
  if (!list.length) return null;
  const byText = [...list].sort((x, y) => x.at - y.at);
  let lo = null, hi = null;
  for (const a of byText) { if (a.at <= at) lo = a; else { hi = a; break; } }
  if (lo && hi && hi.t > lo.t) return lo.t + (hi.t - lo.t) * (at - lo.at) / (hi.at - lo.at);
  const a = !hi || (lo && at - lo.at <= hi.at - at) ? lo : hi;
  return a.t + (at - a.at) / pace(list, a.t);
}
// Finds where in the audio a place in the text is read, by listening: guess a
// time, hear what is being read there, see how far off that is in the text,
// correct the guess, and repeat until it is within a few seconds.
async function findInAudio(at, say) {
  const mine = cur, b = mine.book, starts = mine.text.starts;
  let list = anchorList();
  let t = list.length ? timeAt(at, list) : b.duration * at / mine.text.text.length;
  for (let round = 1; round <= 5 && cur === mine; round++) {
    t = Math.max(0, Math.min(b.duration - 20, t));
    say('Finding the place in the audio… (' + round + ')');
    const r = await transcribeAround(mine.source, t + 8, 8, 8, transcribe, crumb);
    crumb(null);
    const loc = findInBook(mine.text, r.words, r.split);
    if (!loc) { t += 40; continue; }                    // nothing recognisable (music, credits): look a little later
    const here = starts[Math.min(loc.split, starts.length - 1)];
    (b.anchors = b.anchors || []).push([Math.round(t + 8), here]);
    if (b.anchors.length > 400) b.anchors.shift();
    save();
    list = anchorList();
    const next = timeAt(at, list);
    if (Math.abs(at - here) < 250) return Math.max(0, next - 3);   // within a few seconds: land just before it
    t = next - 8;
  }
  return null;
}
async function jumpToFigure(i) {
  if (!cur || !cur.text || !cur.source || probing || queueBusy || naming) { toast('Busy with something else; try again in a moment'); return; }
  const mine = cur, f = mine.meta.figures[i];
  const say = (msg) => { $('viewStatus').textContent = msg; $('figStatus').textContent = msg; };
  probing = true;
  try {
    await warmModel();
    const t = await findInAudio(f.at, say);
    if (cur !== mine) return;
    if (t == null) { say('Could not find this place in the audio.'); return; }
    say('');
    reached.set(i, t);          // arriving here is not "reaching" it
    seek(t);
    for (const id of ['viewDlg', 'figsDlg']) closeSheet($(id));
    toast('Moved to ' + fmt(t));
  } catch (err) {
    say('Stopped: ' + ((err && err.message) || err));
  } finally {
    probing = false; crumb(null);
    runQueue();
  }
}

// ---------- figures tab ----------
function renderFigTab() {
  const n = cur ? cur.meta.figures.length : 0;
  $('figsBtn').hidden = !n;
  $('figsLabel').textContent = String(n);
  $('figsBtn').setAttribute('aria-label', 'Figures, ' + n);
}
$('figsBtn').addEventListener('click', () => {
  const ol = $('figList'), figs = cur.meta.figures;
  ol.textContent = '';
  $('figStatus').textContent = '';
  $('figCount').textContent = '(' + figs.length + ')';
  const est = cur.text ? textAt(audio.currentTime, anchorList()) : null;
  let nextOne = null;
  figs.forEach((f, i) => {
    const li = el('li'), view = el('button', 'figrow'), text = el('span', 'figtext');
    const sec = entryAt(cur.meta.toc, f.at);
    text.append(el('span', 'figcap', figureName(f, i)), el('span', 'muted', (f.kind === 'table' ? 'Table' : 'Picture') + (sec ? ' · ' + sec.label : '')));
    view.append(text);
    view.addEventListener('click', () => openFigure(i));
    const go = el('button', 'round');
    go.setAttribute('aria-label', 'Go to this in the audio');
    go.append(icon('M7 5v14l11-7z'));
    go.addEventListener('click', () => jumpToFigure(i));
    li.append(view, go);
    if (est != null && nextOne == null && f.at > est) { nextOne = li; li.classList.add('upnext'); }
    ol.append(li);
  });
  $('figsDlg').showModal();
  $('figsDlg').scrollTop = 0;
  if (nextOne) nextOne.scrollIntoView({ block: 'center' });
});
$('figsClose').addEventListener('click', () => closeSheet($('figsDlg')));
async function probe(t) {
  if (probing || queueBusy || naming || !canWork() || !cur.source || modelState === 'failed' || Date.now() < probeRest) return;
  probing = true;
  const mine = cur, b = mine.book;
  try {
    await warmModel();
    const r = await transcribeAround(mine.source, t, 12, 3, transcribe, crumb);
    const loc = findInBook(mine.text, r.words, r.split);
    if (loc && mine.text.starts.length) {
      (b.anchors = b.anchors || []).push([Math.round(t), mine.text.starts[Math.min(loc.split, mine.text.starts.length - 1)]]);
      if (b.anchors.length > 400) b.anchors.shift();
      save();
    } else {
      probeRest = Date.now() + 60000;   // nothing recognisable here (music, credits): wait before trying again
    }
  } catch (err) {
    probeRest = Date.now() + 60000;
  }
  crumb(null);
  probing = false;
  runQueue();
}

let trackLast = null, trackChecked = 0, pendingFigure = null;
const reached = new Map();    // figure index -> audio time it was announced at
function trackFigures() {
  if (Date.now() - trackChecked < 2000) return;
  trackChecked = Date.now();
  if (!cur || !settings.figAlert || !cur.text || !cur.meta.figures.length || audio.paused) return;
  const t = audio.currentTime, list = anchorList(), est = textAt(t, list), figs = cur.meta.figures;
  const gap = list.reduce((best, a) => Math.min(best, Math.abs(a.t - t)), Infinity);
  const next = est == null ? null : figs.find((f) => f.at > est);
  const soon = !!next && (next.at - est) / pace(list, t) < 90;
  if (gap > PROBE_EVERY || (soon && gap > PROBE_NEAR)) probe(t);
  if (est == null) return;
  // Announce each figure the reading has just passed. A jump (seek, or a fresh
  // anchor correcting the estimate backwards) is not "passing".
  if (trackLast && t > trackLast.t && t - trackLast.t < 15 && est > trackLast.est) {
    figs.forEach((f, i) => {
      if (f.at <= trackLast.est || f.at > est) return;
      if (reached.has(i) && Math.abs(reached.get(i) - t) < 180) return;
      reached.set(i, t);
      reachFigure(i);
    });
  }
  trackLast = { t, est };
}
function reachFigure(i) {
  const f = cur.meta.figures[i], what = (f.kind === 'table' ? 'Table' : 'Picture') + (f.cap ? ': ' + f.cap : '');
  log('figure reached at ' + fmt(audio.currentTime) + ': ' + what.slice(0, 60));
  sound('figure');
  if (settings.figPause) pause();
  pendingFigure = i;
  showPendingFigure();
  toast(what.length > 60 ? what.slice(0, 58) + '…' : what);
}
// Opens the figure straight away if the app is on screen, otherwise the next time it is.
function showPendingFigure() {
  if (pendingFigure == null || !cur || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) return;
  const i = pendingFigure;
  pendingFigure = null;
  openFigure(i);
}

// ---------- sheets: bookmarks and book info ----------
$('marksBtn').addEventListener('click', () => { renderMarks(); $('marksDlg').showModal(); $('marksDlg').scrollTop = 0; });
$('marksClose').addEventListener('click', () => closeSheet($('marksDlg')));
const PENCIL = 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4';
function icon(d, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); svg.append(path);
  return svg;
}
// A value with a pencil beside it. Tapping the pencil turns the text into a
// plain underlined field; Return or tapping away saves, Escape cancels.
function editable(value, label, onSave, shown) {
  const wrap = el('span', 'editable'), text = el('span', '', shown || value || '—');
  const btn = el('button', 'pencil');
  btn.type = 'button'; btn.setAttribute('aria-label', 'Edit ' + label); btn.append(icon(PENCIL));
  btn.addEventListener('click', () => {
    const input = el('input', 'inline');
    input.type = 'text'; input.value = value; input.setAttribute('aria-label', label);
    input.autocomplete = 'off'; input.enterKeyHint = 'done';
    let done = false;
    const finish = (keep) => { if (done) return; done = true; if (keep) onSave(input.value.trim()); else renderInfo(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    wrap.replaceChildren(input);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
  wrap.append(text, btn);
  return wrap;
}

let chaptersOpen = false, chapStatusText = '';
function renderInfo() {
  if (!cur) return;
  const b = cur.book, dl = $('infoList');
  dl.textContent = '';
  const row = (label, value) => {
    const dd = el('dd');
    dd.append(typeof value === 'string' ? document.createTextNode(value) : value);
    dl.append(el('dt', '', label), dd);
    return dd;
  };

  for (const f of ['title', 'author']) {
    // Saving an empty field goes back to the value from the book text or audio file.
    row(f === 'title' ? 'Title' : 'Author', editable(b[f], f, (typed) => {
      const auto = b.fromText[f] || b.fromAudio[f] || '';
      if (!typed || typed === auto) delete b.edited[f]; else b.edited[f] = typed;
      metaChanged();
    }));
  }
  row('Length', fmt(b.duration));

  const ch = b.chapters || [], n = ch.length;
  if (n < 2) {
    row('Chapters', 'none in this audio file');
  } else {
    const toggle = el('button', 'disclose', String(n));
    toggle.setAttribute('aria-expanded', String(chaptersOpen));
    toggle.setAttribute('aria-label', n + ' chapters, ' + (chaptersOpen ? 'hide' : 'show') + ' list');
    toggle.append(icon('M6 9l6 6 6-6'));
    toggle.addEventListener('click', () => { chaptersOpen = !chaptersOpen; renderInfo(); });
    row('Chapters', toggle);
    if (chaptersOpen) {
      const box = el('div', 'chapbox'), ol = el('ol');
      ch.forEach((c, k) => {
        const li = el('li');
        li.append(el('span', 'muted', fmt(c.start)), editable(c.title, 'name of chapter ' + (k + 1), (typed) => {
          if (typed && typed !== c.title) { keepAudioChapters(b); c.title = typed; c.src = 'you'; }
          chaptersChanged();
        }));
        ol.append(li);
      });
      const tools = el('div', 'row');
      if (cur.text && cur.meta.toc.length) {
        const auto = el('button', 'small', 'Name from book text');
        auto.disabled = naming;
        auto.addEventListener('click', nameChapters);
        tools.append(auto);
      }
      if (b.audioChapters) {
        const reset = el('button', 'small', 'Reset names');
        reset.addEventListener('click', () => {
          if (!confirm('Put back the chapter names from the audio file?')) return;
          b.chapters = b.audioChapters; delete b.audioChapters;
          chaptersChanged();
        });
        tools.append(reset);
      }
      const status = el('p', 'subnote', chapStatusText);
      status.id = 'chapStatus';
      box.append(ol, tools, status);
      dl.append(box);
    }
  }

  if (b.pageSrcName) {
    row('Page PDF', b.pageSrcName + (cur.pageSrc ? ' (' + cur.pageSrc.count + ' pages)' : ''));
    // Scans start with unnumbered front matter; this says where page 1 is.
    if (cur.pageSrc && !cur.pageSrc.labels) {
      row('Page 1 is', editable(String(b.pageFirst || 1), 'which PDF page is printed page 1', (typed) => {
        const n = parseInt(typed.replace(/\D+/g, ''), 10);
        if (n >= 1 && n <= cur.pageSrc.count) { b.pageFirst = n; findPages(true); }
        renderInfo();
      }, 'PDF page ' + (b.pageFirst || 1)));
    }
  }
  row('Audio file', b.audioName + ' (' + b.kind + ')');
  row('Added', new Date(b.added).toLocaleDateString());
  $('pageBtnLabel').textContent = b.pageSrcName ? 'Replace page PDF' : 'Add page PDF';
  $('textStatus').textContent = b.hasText
    ? 'Text: ' + (b.textName || 'added') + '. Bookmarks quote the book’s own wording.'
    : 'No book text yet. Bookmarks show what the app heard; add the EPUB for exact quotes.';
  $('textBtnLabel').textContent = b.hasText ? 'Replace book text' : 'Add book text';
}
// Title and author changed: update everywhere they show.
function metaChanged() {
  const b = cur.book;
  resolveMeta(b); save(true);
  setScroll($('title'), b.title); $('author').textContent = b.author;
  setMediaSession(); renderInfo();
}
$('infoBtn').addEventListener('click', () => { chaptersOpen = false; chapStatusText = ''; renderInfo(); $('infoDlg').showModal(); $('infoDlg').scrollTop = 0; });
$('infoClose').addEventListener('click', () => closeSheet($('infoDlg')));

// ---------- chapter names ----------
const keepAudioChapters = (b) => { if (!b.audioChapters) b.audioChapters = b.chapters.map((c) => ({ start: c.start, title: c.title })); };
function chaptersChanged() {
  save(true); renderInfo();
  renderTime(audio.currentTime || cur.book.position || 0); renderMarks();
}

// Names chapters from the book's contents list. The audio file knows when
// each chapter starts but often not what it is called; the EPUB knows the
// names but not the times. Listening to the first seconds of each chapter
// and finding those words in the text connects the two.
let naming = false;
const LISTEN = 25;        // seconds heard at the start of each chapter
const NEAR_START = 1500;  // characters: how close to a contents entry counts as its beginning
async function nameChapters() {
  if (naming || !cur || !cur.text || !cur.source) return;
  const mine = cur, b = mine.book;
  const say = (msg) => { if (cur !== mine) return; chapStatusText = msg; const p = $('chapStatus'); if (p) p.textContent = msg; };
  naming = true; renderInfo();
  let named = 0;
  try {
    while (queueBusy || probing) { say('Waiting for bookmarks to finish…'); await new Promise((r) => setTimeout(r, 500)); }
    await warmModel();
    for (let i = 0; i < b.chapters.length && cur === mine; i++) {
      const ch = b.chapters[i];
      if (ch.src === 'you') continue;
      say('Listening to the start of chapter ' + (i + 1) + ' of ' + b.chapters.length + '…');
      const r = await transcribeAround(mine.source, ch.start + LISTEN, LISTEN, 0, transcribe, crumb);
      crumb(null);
      const loc = findInBook(mine.text, r.words, 0);
      if (!loc || !mine.text.starts.length) continue;
      const at = mine.text.starts[Math.min(loc.start, mine.text.starts.length - 1)];
      const entry = entryAt(mine.meta.toc, at + 200);
      if (!entry || at - entry.at > NEAR_START || entry.label === ch.title) continue;
      keepAudioChapters(b);
      ch.title = entry.label; ch.src = 'text'; named++;
      save(true);
    }
    say(named ? 'Named ' + named + (named === 1 ? ' chapter' : ' chapters') + ' from the book’s contents. The rest start partway through a section, so they keep their audio names.'
      : 'No chapter starts lined up with the book’s contents, so nothing was changed.');
  } catch (err) {
    say('Stopped: ' + ((err && err.message) || err));
  }
  naming = false; crumb(null);
  if (cur === mine) chaptersChanged();
  runQueue();
}

// ---------- book text and removal ----------
const renderTextStatus = renderInfo;
$('textFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book;
  try {
    toast('Reading ' + f.name + '…');
    const doc = await readBook(f);
    await storeText(b.id, doc);
    b.hasText = true; b.textName = f.name; b.pageCount = doc.pages.length;
    b.fromText = { title: doc.title, author: doc.author };
    // Saved positions pointed into the old text, so they can't be re-cut against the new one.
    for (const m of b.marks) { delete m.loc; delete m.figs; }
    delete b.anchors;
    resolveMeta(b); save(true);
    if (cur !== mine) return;
    mine.meta = { toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true };
    renderFigTab();
    mine.text = buildBook(doc.text);
    metaChanged(); renderTextStatus(); rematch(); runQueue();
    toast('Book text added');
  } catch (err) {
    if (cur === mine) { renderTextStatus(); toast('Could not read that file'); }
  }
});
$('pageFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book, say = (msg) => { if (cur === mine) $('textStatus').textContent = msg; };
  try {
    say('Reading ' + f.name + '…');
    const pdf = await readPdfPages(f, (p) => say('Reading ' + f.name + '… ' + Math.round(p * 100) + '%'));
    await store('write', b.id, 'pagesrc', new Blob([JSON.stringify(pdf)], { type: 'application/json' }));
    await store('write', b.id, 'pagepdf', f);
    b.hasPagePdf = true;
    b.pageSrcName = f.name;
    b.pageFirst = guessFirstNumbered(pdf.pages) || 1;
    save(true);
    if (cur !== mine) return;
    mine.pageSrc = { labels: pdf.labels, count: pdf.pages.length, index: buildPageIndex(pdf.pages) };
    const quotes = b.marks.filter((m) => m.status === 'done').length, found = findPages();
    renderInfo();
    toast(quotes ? 'Pages found for ' + found + ' of ' + quotes + (quotes === 1 ? ' quote' : ' quotes') : 'Page PDF added');
  } catch (err) {
    if (cur === mine) { renderInfo(); toast('Could not use that PDF: ' + ((err && err.message) || err)); }
  }
});
$('removeBtn').addEventListener('click', async () => {
  if (!cur) return;
  const b = cur.book, n = b.marks.length;
  if (!confirm('Remove “' + b.title + '” from this device?' + (n ? ' Its ' + n + (n === 1 ? ' bookmark' : ' bookmarks') + ' will be deleted too.' : ''))) return;
  closeSheet($('infoDlg'));
  closeBook();
  state.books = state.books.filter((x) => x !== b);
  save(true);
  await store('remove', b.id).catch(() => {});
  showLibrary();
});

// ---------- accent color ----------
// One picked color has to work as text and as a button fill on both the
// light and the dark background, so each theme gets its own adjusted shade.
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const luminance = (c) => {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Moves a color toward black or white in small steps until it reads against bg.
function readable(color, bg, toward) {
  let c = color;
  for (let i = 0; i < 24 && contrast(c, bg) < 4.5; i++) c = c.map((v, k) => v + (toward[k] - v) * 0.08);
  return c;
}
const LIGHT_BG = [246, 245, 241], DARK_BG = [21, 22, 20], INK = [17, 17, 17], PAPER = [255, 255, 255];
const PRESETS = [[null, '#16a34a', 'Green'], ['#2563eb', '#2563eb', 'Blue'], ['#7c3aed', '#7c3aed', 'Violet'],
  ['#e11d48', '#e11d48', 'Rose'], ['#ea580c', '#ea580c', 'Orange'], ['#0d9488', '#0d9488', 'Teal']];
function applyAccent() {
  const st = document.documentElement.style;
  const names = ['--accent-light', '--accent-fg-light', '--accent-dark', '--accent-fg-dark'];
  if (!/^#[0-9a-f]{6}$/i.test(settings.accent || '')) { names.forEach((n) => st.removeProperty(n)); return; }
  const base = hexToRgb(settings.accent);
  const light = readable(base, LIGHT_BG, [0, 0, 0]), dark = readable(base, DARK_BG, PAPER);
  const on = (c) => (contrast(PAPER, c) >= contrast(INK, c) ? '#ffffff' : '#111111');
  [rgbToHex(light), on(light), rgbToHex(dark), on(dark)].forEach((v, i) => st.setProperty(names[i], v));
}
function renderSwatches() {
  const preset = PRESETS.find((p) => p[0] === (settings.accent || null));
  for (const b of document.querySelectorAll('.swatch[data-i]')) b.setAttribute('aria-pressed', String(PRESETS[b.dataset.i] === preset));
  document.querySelector('.swatch.custom').classList.toggle('on', !preset);
  $('accentOut').textContent = preset ? preset[2] : 'Custom';
  if (settings.accent) $('accentPick').value = settings.accent;
}
PRESETS.forEach(([value, shown, name], i) => {
  const b = el('button', 'swatch');
  b.type = 'button'; b.dataset.i = i; b.style.setProperty('--c', shown); b.setAttribute('aria-label', name);
  b.addEventListener('click', () => { settings.accent = value; applyAccent(); renderSwatches(); save(true); });
  $('swatches').insertBefore(b, document.querySelector('.swatch.custom'));
});
$('accentPick').addEventListener('input', (e) => { settings.accent = e.target.value; applyAccent(); renderSwatches(); });
$('accentPick').addEventListener('change', () => save(true));
applyAccent();

// The filled part of every slider follows its value.
function fillRange(input) {
  const min = Number(input.min), max = Number(input.max);
  input.style.setProperty('--f', max > min ? (Number(input.value) - min) / (max - min) : 0);
}
document.addEventListener('input', (e) => { if (e.target.type === 'range') fillRange(e.target); });

// ---------- settings ----------
// Each slider: element id, where its value lives, and how to show it.
const secs = (v) => v + ' s';
const paras = (v) => '+' + v;
const SLIDERS = [
  ['nextSecs', settings.next, 'secs', secs], ['prevSecs', settings.prev, 'secs', secs],
  ['skipBack', settings, 'skipBack', secs], ['skipFwd', settings, 'skipFwd', secs],
  ['capBefore', settings.capture, 'before', secs], ['capAfter', settings.capture, 'after', secs],
  ['parasBefore', settings.capture, 'parasBefore', paras], ['parasAfter', settings.capture, 'parasAfter', paras],
];
const isSkip = (a) => a === 'fwd' || a === 'back';
function renderSettings() {
  for (const [id, obj, key, show] of SLIDERS) {
    const input = $(id);
    input.value = Math.max(Number(input.min), Math.min(Number(input.max), obj[key]));
    $(id + 'Out').textContent = show(Number(input.value));
    fillRange(input);
  }
  renderSwatches();
  $('nextAction').value = settings.next.action; $('prevAction').value = settings.prev.action;
  $('nextSecsField').hidden = !isSkip(settings.next.action);
  $('prevSecsField').hidden = !isSkip(settings.prev.action);
  $('capMode').value = settings.capture.mode;
  $('capTime').hidden = settings.capture.mode !== 'time';
  $('capParas').hidden = settings.capture.mode !== 'paras';
  $('lockSeek').value = settings.lockSeek ? 'skip' : 'track';
  $('bgQuotes').checked = settings.bgQuotes;
  $('sounds').checked = settings.sounds; $('figAlert').checked = settings.figAlert; $('figPause').checked = settings.figPause;
  $('figPauseRow').hidden = !settings.figAlert;
  $('backwardLabel').textContent = settings.skipBack; $('forwardLabel').textContent = settings.skipFwd;
  $('backward').setAttribute('aria-label', 'Back ' + settings.skipBack + ' seconds');
  $('forward').setAttribute('aria-label', 'Forward ' + settings.skipFwd + ' seconds');
}
function readSettings() {
  const was = JSON.stringify(settings.capture);
  for (const [id, obj, key] of SLIDERS) obj[key] = Number($(id).value);
  settings.next.action = $('nextAction').value; settings.prev.action = $('prevAction').value;
  settings.capture.mode = $('capMode').value;
  settings.lockSeek = $('lockSeek').value === 'skip';
  settings.bgQuotes = $('bgQuotes').checked;
  settings.sounds = $('sounds').checked; settings.figAlert = $('figAlert').checked; settings.figPause = $('figPause').checked;
  save(true);
  renderSettings(); setMediaSession(); runQueue();
  if (JSON.stringify(settings.capture) !== was) requoteAll();
}
$('settingsDlg').addEventListener('change', readSettings);
// Show the number while a slider is being dragged; it is saved on release.
$('settingsDlg').addEventListener('input', (e) => {
  const row = SLIDERS.find((r) => r[0] === e.target.id);
  if (row) $(row[0] + 'Out').textContent = row[3](Number(e.target.value));
});
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', () => { renderSettings(); $('settingsDlg').showModal(); $('settingsDlg').scrollTop = 0; });
$('settingsClose').addEventListener('click', () => closeSheet($('settingsDlg')));
$('logCopy').addEventListener('click', async () => {
  const text = logLines.join('\n') + '\n' + navigator.userAgent;
  try { await navigator.clipboard.writeText(text); toast('Log copied'); } catch (e) { toast('Copy failed'); }
});
// A home-screen app has no reload button, so Settings provides one. It asks
// the service worker to look for new files first, then reloads the page.
$('appReload').addEventListener('click', async () => {
  $('appReload').disabled = true;
  if (cur) { cur.book.position = audio.currentTime || cur.book.position; save(true); }
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch (e) { /* offline: reload with what we have */ }
  location.reload();
});
// Every published build has a number, here and in version.json. When the
// server's number differs from this one, a newer version is waiting.
const BUILD = '1795512047';
const buildDate = (b) => new Date(Number(b) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
async function latestBuild() {
  const res = await fetch('version.json', { cache: 'no-store' });
  return String((await res.json()).build);
}
async function showVersion() {
  const mine = 'This version: ' + buildDate(BUILD) + '.';
  $('appVersion').textContent = mine;
  try {
    const latest = await latestBuild();
    $('appVersion').textContent = mine + (latest === BUILD ? ' Up to date.' : ' A newer one (' + buildDate(latest) + ') is available: tap Reload app.');
  } catch (e) {
    $('appVersion').textContent = mine + ' Could not check for a newer one (offline?).';
  }
}
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', showVersion);
// On launch and whenever the app comes back to the screen: if a newer build
// is published and nothing is playing or open, switch to it straight away.
// Remembering the build it reloaded for stops this from looping.
async function autoUpdate() {
  try {
    const latest = await latestBuild();
    if (latest === BUILD || sessionStorage.getItem('borkmark.reloadedFor') === latest) return;
    if (!audio.paused || document.querySelector('dialog[open]')) return;
    sessionStorage.setItem('borkmark.reloadedFor', latest);
    log('updating to build ' + latest);
    if (cur) { cur.book.position = audio.currentTime || cur.book.position; save(true); }
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update().catch(() => {});
    location.reload();
  } catch (e) { /* offline, or storage unavailable */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoUpdate(); });
autoUpdate();
renderSettings();

// A bookmark that was mid-transcription when the app closed is not retried
// automatically: if it crashed the app once, it would do so on every launch.
for (const b of state.books) {
  for (const m of b.marks) {
    if (m.status === 'working') { m.status = 'error'; m.error = 'The app closed while finding this quote. Tap Retry to try again.'; }
  }
}
save(true);

if (lastCrash) {
  $('crashNote').hidden = false;
  $('crashText').textContent = 'Last time, the app closed unexpectedly while ' + lastCrash.stage
    + (lastCrash.playing ? ' (audio was playing).' : '.') + ' Bookmarks are safe; any unfinished quote has a Retry button.';
}
$('crashDismiss').addEventListener('click', () => { $('crashNote').hidden = true; });
$('modelRetry').addEventListener('click', () => { $('crashNote').hidden = true; warmModel().catch(() => {}); });

// Load the model at launch, before any audio is playing. Skipped once after
// a crash during loading so the app can't get stuck in a crash loop.
const crashedLoading = lastCrash && /speech model/.test(lastCrash.stage);
$('modelRetry').hidden = !crashedLoading;
if (state.books.length && !crashedLoading) warmModel().catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
renderLibrary();
