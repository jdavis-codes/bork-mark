import { openAudio, readBook, buildBook, transcribeAround, quoteFor } from './align.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

const KEY = 'borkmark.v1';
const MODEL = 'onnx-community/whisper-tiny.en_timestamped';
const CLIP_BEFORE = 45, CLIP_AFTER = 15;   // seconds of audio transcribed around a bookmark
const MERGE_WINDOW = 3000;                 // repeated presses within this many ms count once

// ---------- saved state ----------
let state = { books: [] };
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved && Array.isArray(saved.books)) state = saved;
} catch (e) { /* storage unavailable: run without persistence */ }

// What each button does. `next` and `prev` are the track buttons a headset or
// watch sends; an action is mark | fwd | back | nextChapter | prevChapter | none.
const DEFAULTS = {
  next: { action: 'mark', secs: 30 },
  prev: { action: 'mark', secs: 30 },
  skipBack: 30, skipFwd: 30,     // on-screen and lock-screen skip buttons
  lockSeek: true,                // lock screen shows skip buttons rather than track buttons
  bgQuotes: false,               // find quotes while the phone is locked
};
const settings = state.settings = {
  ...DEFAULTS, ...(state.settings || {}),
  next: { ...DEFAULTS.next, ...((state.settings || {}).next || {}) },
  prev: { ...DEFAULTS.prev, ...((state.settings || {}).prev || {}) },
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
log('--- app opened');

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
let toastTimer = null;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
}

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
    btn.addEventListener('click', () => openBook(b.id));
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
let adding = false;
const addReset = () => {
  $('addAudio').value = ''; $('addText').value = '';
  $('addAudioName').textContent = 'Required.';
  $('addTextName').textContent = 'Optional. Needed for exact quotes; you can add it later.';
  $('addStatus').textContent = ''; $('addStatus').className = 'muted';
  $('addGo').disabled = true;
};
$('addBtn').addEventListener('click', () => { addReset(); $('addDlg').showModal(); });
$('addCancel').addEventListener('click', () => { if (!adding) $('addDlg').close(); });
$('addDlg').addEventListener('cancel', (e) => { if (adding) e.preventDefault(); });
$('addAudio').addEventListener('change', (e) => {
  const f = e.target.files[0];
  $('addAudioName').textContent = f ? f.name + ' · ' + (f.size / 1048576).toFixed(0) + ' MB' : 'Required.';
  $('addGo').disabled = !f;
});
$('addText').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) $('addTextName').textContent = f.name;
});
$('addGo').addEventListener('click', async () => {
  const af = $('addAudio').files[0], tf = $('addText').files[0];
  if (!af || adding) return;
  adding = true; $('addGo').disabled = true; $('addCancel').disabled = true;
  const say = (m) => { $('addStatus').textContent = m; $('addStatus').className = 'muted'; };
  const id = crypto.randomUUID();
  try {
    say('Reading audio…');
    const src = await openAudio(af, (p) => say('Reading audio… ' + Math.round(p * 100) + '%'));
    let text = null;
    if (tf) { say('Reading text…'); text = await readBook(tf); }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await store('write', id, 'audio', af, (p) => say('Copying audio… ' + Math.round(p * 100) + '%'));
    if (src.tags.cover) await store('write', id, 'cover', src.tags.cover);
    if (text != null) await store('write', id, 'text', new Blob([text], { type: 'text/plain' }));
    state.books.unshift({
      id, title: src.tags.title || af.name.replace(/\.[^.]+$/, ''), author: src.tags.author || '',
      audioName: af.name, kind: src.kind, duration: src.duration, chapters: src.chapters,
      hasCover: !!src.tags.cover, hasText: text != null, textName: tf ? tf.name : '',
      position: 0, speed: 1, added: Date.now(), marks: [],
    });
    save(true);
    $('addDlg').close();
    await openBook(id);
    warmModel().catch(() => {});
  } catch (err) {
    await store('remove', id).catch(() => {});
    $('addStatus').textContent = 'Could not add this book: ' + ((err && err.message) || err);
    $('addStatus').className = 'warn';
    $('addGo').disabled = false;
  }
  adding = false; $('addCancel').disabled = false;
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

async function openBook(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  const file = await stored(id, 'audio');
  if (!file) { toast('The audio for this book is missing from this device'); return; }
  closeBook(true);
  cur = { book, source: null, text: null, audioUrl: null, coverUrl: null };
  $('library').hidden = true; $('player').hidden = false;
  window.scrollTo(0, 0);
  $('title').textContent = book.title;
  $('author').textContent = book.author;
  $('playerError').hidden = true;
  $('speed').value = String(book.speed || 1);
  $('cover').hidden = true;
  cur.audioUrl = URL.createObjectURL(await playable(file));
  audio.src = cur.audioUrl;
  audio.playbackRate = book.speed || 1;
  renderTime(book.position || 0);
  renderMarks(); renderTextStatus(); setMediaSession();

  const mine = cur;
  if (book.hasCover) stored(id, 'cover').then((f) => {
    if (!f || cur !== mine) return;
    mine.coverUrl = URL.createObjectURL(f);
    $('cover').src = mine.coverUrl; $('cover').hidden = false;
    setMediaSession();
  });
  openAudio(file).then((s) => { if (cur === mine) { mine.source = s; runQueue(); } })
    .catch((e) => { if (cur === mine) setQueueStatus('Cannot read this audio for quotes: ' + e.message); });
  if (book.hasText) stored(id, 'text').then(async (f) => {
    if (!f || cur !== mine) return;
    mine.text = buildBook(await f.text());
    rematch(); runQueue();
  });
}

function closeBook(silent) {
  if (!cur) return;
  audio.pause();
  cur.book.position = audio.currentTime || cur.book.position || 0;
  save(true);
  audio.removeAttribute('src'); audio.load();
  if (cur.audioUrl) URL.revokeObjectURL(cur.audioUrl);
  if (cur.coverUrl) URL.revokeObjectURL(cur.coverUrl);
  cur = null;
  if (!silent) { $('player').hidden = true; $('library').hidden = false; renderLibrary(); }
}
$('backBtn').addEventListener('click', () => closeBook());

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
});
audio.addEventListener('error', () => {
  if (!cur || !audio.getAttribute('src')) return;
  const e = audio.error;
  $('playerError').hidden = false;
  $('playerError').textContent = 'This file cannot be played here (code ' + (e ? e.code : '?') + (e && e.message ? ': ' + e.message : '') + ').';
});
const PLAY = 'M8 5v14l11-7z', PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
function syncPlayState() {
  const playing = !audio.paused;
  $('playIcon').setAttribute('d', playing ? PAUSE : PLAY);
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (!playing && cur) save(true);
}
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', syncPlayState);
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('seeked', updatePositionState);
document.addEventListener('visibilitychange', () => {
  log('page ' + document.visibilityState);
  if (document.visibilityState === 'hidden') { if (cur) save(true); }
  runQueue();
});

function renderTime(t) {
  const b = cur.book, c = chapterAt(b, t);
  const label = c.count > 1 ? c.title : 'Whole book';
  $('chapterBtn').textContent = c.count > 1 ? label + '  ▾' : label;
  $('chapterBtn').disabled = c.count <= 1;
  const s = $('scrub');
  s.min = Math.floor(c.start); s.max = Math.max(Math.floor(c.start) + 1, Math.ceil(c.end)); s.value = t;
  $('elapsed').textContent = fmt(t - c.start);
  $('remaining').textContent = '−' + fmt(c.end - t);
  $('overall').textContent = fmt(t) + ' of ' + fmt(b.duration);
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
  $('overall').textContent = fmt(t) + ' of ' + fmt(cur.book.duration);
});
$('scrub').addEventListener('change', () => { scrubbing = false; seek(Number($('scrub').value)); });
// Starts playback, and checks a few seconds later that it really started.
// If Safari accepted the request but nothing is playing, it has usually let
// go of the file while paused, so the file is reopened and tried once more.
let wantPlaying = false, playCheck = null;
function play(isRetry) {
  if (!cur) return;
  wantPlaying = true;
  const from = audio.currentTime;
  const p = audio.play();
  if (p) p.catch((e) => { log('play() refused: ' + e.name + ': ' + e.message); if (!isRetry) toast('Cannot play: ' + e.message); });
  clearTimeout(playCheck);
  playCheck = setTimeout(() => {
    if (!cur || !wantPlaying) return;
    if (!audio.paused && audio.currentTime !== from) return;   // playing normally
    log('playback did not start (paused=' + audio.paused + ', readyState=' + audio.readyState + ', networkState=' + audio.networkState
      + ', error=' + (audio.error ? audio.error.code : 'none') + ')' + (isRetry ? '; giving up' : '; reopening the file'));
    if (isRetry) { toast('Playback would not restart. Go back to the library and reopen the book.'); return; }
    const t = cur.book.position;
    audio.addEventListener('loadedmetadata', () => { cur.book.position = t; play(true); }, { once: true });
    audio.src = cur.audioUrl;
    audio.load();
    cur.book.position = t;
  }, 2500);
}
function pause() { wantPlaying = false; clearTimeout(playCheck); audio.pause(); }
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
    case 'fwd': seek(t + cfg.secs); break;
    case 'back': seek(t - cfg.secs); break;
    case 'nextChapter': if (c.i + 1 < ch.length) seek(ch[c.i + 1].start); break;
    // Like a music player: first press returns to the chapter start.
    case 'prevChapter': seek(t - c.start > 3 || c.i === 0 ? c.start : ch[c.i - 1].start); break;
  }
}
$('speed').addEventListener('change', () => {
  if (!cur) return;
  cur.book.speed = Number($('speed').value);
  audio.playbackRate = cur.book.speed;
  save(true);
});

// chapters
$('chapterBtn').addEventListener('click', () => {
  const b = cur.book, now = chapterAt(b, audio.currentTime).i, ol = $('chapList');
  ol.textContent = '';
  let current = null;
  chaptersOf(b).forEach((ch, i) => {
    const btn = el('button');
    btn.append(el('span', '', ch.title), el('span', '', fmt(ch.start)));
    if (i === now) { btn.setAttribute('aria-current', 'true'); current = btn; }
    btn.addEventListener('click', () => { seek(ch.start); $('chapDlg').close(); });
    const li = el('li'); li.append(btn); ol.append(li);
  });
  $('chapDlg').showModal();
  if (current) current.scrollIntoView({ block: 'center' });
});
$('chapClose').addEventListener('click', () => $('chapDlg').close());

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
  on('pause', () => { log('button: pause'); pause(); });
  // With seek handlers set, the lock screen shows skip buttons, while a watch
  // or headset still sends next / previous.
  on('seekbackward', settings.lockSeek ? () => log('button: skip back') || seek(audio.currentTime - settings.skipBack) : null);
  on('seekforward', settings.lockSeek ? () => log('button: skip forward') || seek(audio.currentTime + settings.skipFwd) : null);
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
  $('markCount').textContent = b.marks.length ? '(' + b.marks.length + ')' : '';
  if (!b.marks.length) {
    ol.append(el('li', 'muted', 'None yet. Press Bookmark, or next / previous track on your headphones or watch.'));
    return;
  }
  for (const m of b.marks) {
    const li = el('li', 'mark');
    const top = el('div');
    top.append(el('span', 'when', fmt(m.t)));
    const c = chapterAt(b, m.t);
    if (c.count > 1) top.append(el('span', 'muted', '  ' + c.title));
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

    const actions = el('div', 'row');
    if (extra) actions.append(extra);
    const play = el('button', 'small', 'Play');
    play.addEventListener('click', () => { seek(m.t - 30); play(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    actions.append(play);
    if (m.status === 'done' || m.transcript) {
      const copy = el('button', 'small', 'Copy');
      copy.addEventListener('click', async () => {
        const body = m.status === 'done' ? (m.before + m.after).trim() : m.transcript;
        const where = [b.title, c.count > 1 ? c.title : '', fmt(m.t)].filter(Boolean).join(', ');
        try { await navigator.clipboard.writeText(body + '\n\n— ' + where); toast('Copied'); } catch (e) { toast('Copy failed'); }
      });
      actions.append(copy);
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
  const q = quoteFor(text, m.words, m.split);
  if (!q) { m.status = 'nomatch'; return; }
  m.status = 'done'; m.before = q.before; m.after = q.after; m.confidence = q.confidence;
  delete m.words; delete m.split; delete m.transcript;
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
  if (queueBusy || !cur || !cur.source || !canWork()) return;
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
        const r = await transcribeAround(mine.source, m.t, CLIP_BEFORE, CLIP_AFTER, transcribe, crumb);
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

// ---------- book text and removal ----------
function renderTextStatus() {
  const b = cur.book;
  $('textStatus').textContent = b.hasText
    ? 'Text: ' + (b.textName || 'added') + '. Bookmarks quote the book’s own wording.'
    : 'No book text yet. Bookmarks show what the app heard; add the EPUB for exact quotes.';
  $('textBtnLabel').textContent = b.hasText ? 'Replace book text' : 'Add book text';
}
$('textFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur;
  try {
    $('textStatus').textContent = 'Reading ' + f.name + '…';
    const text = await readBook(f);
    await store('write', mine.book.id, 'text', new Blob([text], { type: 'text/plain' }));
    mine.book.hasText = true; mine.book.textName = f.name;
    save(true);
    if (cur !== mine) return;
    mine.text = buildBook(text);
    renderTextStatus(); rematch(); runQueue();
    toast('Book text added');
  } catch (err) {
    if (cur === mine) { renderTextStatus(); toast('Could not read that file'); }
  }
});
$('removeBtn').addEventListener('click', async () => {
  if (!cur) return;
  const b = cur.book, n = b.marks.length;
  if (!confirm('Remove “' + b.title + '” from this device?' + (n ? ' Its ' + n + (n === 1 ? ' bookmark' : ' bookmarks') + ' will be deleted too.' : ''))) return;
  closeBook(true);
  state.books = state.books.filter((x) => x !== b);
  save(true);
  await store('remove', b.id).catch(() => {});
  $('player').hidden = true; $('library').hidden = false;
  renderLibrary();
});

// ---------- settings ----------
const clampSecs = (v, fallback) => { const n = Math.round(Number(v)); return n >= 1 && n <= 600 ? n : fallback; };
function renderSettings() {
  for (const k of ['next', 'prev']) {
    $(k + 'Action').value = settings[k].action;
    $(k + 'Secs').value = settings[k].secs;
    $(k + 'SecsRow').hidden = settings[k].action !== 'fwd' && settings[k].action !== 'back';
  }
  $('skipBack').value = settings.skipBack; $('skipFwd').value = settings.skipFwd;
  $('lockSeek').value = settings.lockSeek ? 'skip' : 'track';
  $('bgQuotes').checked = settings.bgQuotes;
  $('backwardLabel').textContent = settings.skipBack; $('forwardLabel').textContent = settings.skipFwd;
  $('backward').setAttribute('aria-label', 'Back ' + settings.skipBack + ' seconds');
  $('forward').setAttribute('aria-label', 'Forward ' + settings.skipFwd + ' seconds');
}
function readSettings() {
  for (const k of ['next', 'prev']) {
    settings[k].action = $(k + 'Action').value;
    settings[k].secs = clampSecs($(k + 'Secs').value, settings[k].secs);
  }
  settings.skipBack = clampSecs($('skipBack').value, settings.skipBack);
  settings.skipFwd = clampSecs($('skipFwd').value, settings.skipFwd);
  settings.lockSeek = $('lockSeek').value === 'skip';
  settings.bgQuotes = $('bgQuotes').checked;
  save(true);
  renderSettings(); setMediaSession(); runQueue();
}
$('settingsDlg').addEventListener('change', readSettings);
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', () => { renderSettings(); $('settingsDlg').showModal(); });
$('settingsClose').addEventListener('click', () => $('settingsDlg').close());
$('logCopy').addEventListener('click', async () => {
  const text = logLines.join('\n') + '\n' + navigator.userAgent;
  try { await navigator.clipboard.writeText(text); toast('Log copied'); } catch (e) { toast('Copy failed'); }
});
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
