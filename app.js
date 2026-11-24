import { openAudio, readBook, buildBook, transcribeAround, findInBook, quoteAt } from './align.js';

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

// What each button does. `next` and `prev` are the track buttons a headset or
// watch sends; an action is mark | fwd | back | nextChapter | prevChapter | none.
const DEFAULTS = {
  next: { action: 'mark', secs: 30 },
  prev: { action: 'mark', secs: 30 },
  skipBack: 30, skipFwd: 30,     // on-screen and lock-screen skip buttons
  lockSeek: true,                // lock screen shows skip buttons rather than track buttons
  bgQuotes: false,               // find quotes while the phone is locked
  // What a bookmark captures: seconds of audio either side, or whole paragraphs.
  capture: { mode: 'time', before: 45, after: 15, parasBefore: 1, parasAfter: 1 },
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
function closeSheet(d) {
  if (!d.open || d.classList.contains('closing')) return;
  if (calm.matches) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.classList.remove('closing'); d.close(); }, 200);
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
const addReset = () => {
  $('addAudio').value = ''; $('addText').value = '';
  $('addAudioName').textContent = 'Required.';
  $('addTextName').textContent = 'Optional. Needed for exact quotes; you can add it later.';
  $('addStatus').textContent = ''; $('addStatus').className = 'muted';
  $('addGo').disabled = true;
};
$('addBtn').addEventListener('click', () => { addReset(); $('addDlg').showModal(); });
$('addCancel').addEventListener('click', () => { if (!adding) closeSheet($('addDlg')); });
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
    closeSheet($('addDlg'));
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
  if (cur && cur.book === book) { showPlayer(); return; }   // already loaded, maybe playing
  const file = await stored(id, 'audio');
  if (!file) { toast('The audio for this book is missing from this device'); return; }
  closeBook();
  cur = { book, source: null, text: null, audioUrl: null, coverUrl: null };
  showPlayer();
  $('title').textContent = book.title;
  $('author').textContent = book.author;
  $('playerError').hidden = true;
  renderInfo();
  renderSpeed();
  $('cover').removeAttribute('src');
  cur.audioUrl = URL.createObjectURL(await playable(file));
  audio.src = cur.audioUrl;
  audio.playbackRate = book.speed || 1;
  renderTime(book.position || 0);
  renderMarks(); renderTextStatus(); setMediaSession();

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
    mine.text = buildBook(await f.text());
    rematch(); runQueue();
  });
}

// The two screens. Going to the library leaves the book loaded and playing,
// with a mini player along the bottom.
function showPlayer() {
  $('library').hidden = true; $('player').hidden = false;
  $('tabbar').hidden = false; document.body.classList.add('has-bar');
  renderMini();
  window.scrollTo(0, 0);
}
function showLibrary() {
  $('player').hidden = true; $('library').hidden = false;
  $('tabbar').hidden = true; document.body.classList.remove('has-bar');
  renderLibrary(); renderMini();
  window.scrollTo(0, 0);
}

function closeBook() {
  if (!cur) return;
  setSleep(null);
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
$('backBtn').addEventListener('click', showLibrary);

// ---------- mini player (library screen) ----------
function renderMini() {
  const show = !!cur && !$('library').hidden;
  $('mini').hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (!show) return;
  const b = cur.book, t = audio.currentTime || b.position || 0, c = chapterAt(b, t);
  $('miniTitle').textContent = b.title;
  $('miniSub').textContent = fmt(t) + (c.count > 1 ? ' · ' + c.title : '');
  $('miniCover').hidden = !cur.coverUrl;
  if (cur.coverUrl && $('miniCover').getAttribute('src') !== cur.coverUrl) $('miniCover').src = cur.coverUrl;
  $('miniFill').style.width = (100 * t / (b.duration || 1)) + '%';
}
$('miniOpen').addEventListener('click', showPlayer);
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
});
audio.addEventListener('error', () => {
  if (!cur || !audio.getAttribute('src')) return;
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
document.addEventListener('visibilitychange', () => {
  log('page ' + document.visibilityState);
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
  const h = Math.floor(left / 3600), m = Math.round((left % 3600) / 60);
  const leftText = left < 30 ? 'finished' : (h ? h + 'h ' : '') + (h || m ? m + 'm' : '<1m') + ' left';
  $('pie').style.setProperty('--p', (frac * 100).toFixed(1));
  $('overallText').textContent = Math.floor(frac * 100) + '% · ' + leftText;
  $('overall').setAttribute('aria-label', Math.floor(frac * 100) + ' percent of the book, ' + leftText);
}

function renderTime(t) {
  const b = cur.book, c = chapterAt(b, t);
  const label = c.count > 1 ? c.title : 'Whole book';
  $('chapterBtn').textContent = c.count > 1 ? label + '  ▾' : label;
  $('chapterBtn').disabled = c.count <= 1;
  const s = $('scrub');
  s.min = Math.floor(c.start); s.max = Math.max(Math.floor(c.start) + 1, Math.ceil(c.end)); s.value = t;
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

// Starts playback, and checks a few seconds later that audio is really
// moving. Safari can report "playing" while nothing comes out.
let wantPlaying = false, playCheck = null;
function play(isRetry) {
  if (!cur) return;
  wantPlaying = true;
  keepAlive(true);
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
    case 'fwd': seek(t + cfg.secs); break;
    case 'back': seek(t - cfg.secs); break;
    case 'nextChapter': if (c.i + 1 < ch.length) seek(ch[c.i + 1].start); break;
    // Like a music player: first press returns to the chapter start.
    case 'prevChapter': seek(t - c.start > 3 || c.i === 0 ? c.start : ch[c.i - 1].start); break;
  }
}
const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
function renderSpeed() {
  const v = (cur && cur.book.speed) || 1;
  $('speedLabel').textContent = v + '×';
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
  const n = b.marks.length, waiting = b.marks.filter((m) => m.status === 'pending' || m.status === 'working').length;
  $('markCount').textContent = n ? '(' + n + ')' : '';
  $('marksLabel').textContent = n ? n + (waiting ? ' · ' + waiting + ' pending' : n === 1 ? ' bookmark' : ' bookmarks') : 'Bookmarks';
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

    const actions = el('div', 'row');
    if (extra) actions.append(extra);
    const play = el('button', 'small', 'Play');
    play.addEventListener('click', () => { seek(m.t - 30); play(); closeSheet($('marksDlg')); });
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
}
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

// ---------- sheets: bookmarks and book info ----------
$('marksBtn').addEventListener('click', () => { renderMarks(); $('marksDlg').showModal(); $('marksDlg').scrollTop = 0; });
$('marksClose').addEventListener('click', () => closeSheet($('marksDlg')));
function renderInfo() {
  if (!cur) return;
  const b = cur.book, dl = $('infoList');
  dl.textContent = '';
  const rows = [['Title', b.title], ['Author', b.author], ['Length', fmt(b.duration)],
    ['Chapters', b.chapters && b.chapters.length > 1 ? String(b.chapters.length) : 'none in this file'],
    ['Audio file', b.audioName + ' (' + b.kind + ')'], ['Added', new Date(b.added).toLocaleDateString()]];
  for (const [k, v] of rows) if (v) dl.append(el('dt', '', k), el('dd', '', v));
}
$('infoBtn').addEventListener('click', () => { renderInfo(); renderTextStatus(); $('infoDlg').showModal(); });
$('infoClose').addEventListener('click', () => closeSheet($('infoDlg')));

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
  closeSheet($('infoDlg'));
  closeBook();
  state.books = state.books.filter((x) => x !== b);
  save(true);
  await store('remove', b.id).catch(() => {});
  showLibrary();
});

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
  }
  $('nextAction').value = settings.next.action; $('prevAction').value = settings.prev.action;
  $('nextSecsField').hidden = !isSkip(settings.next.action);
  $('prevSecsField').hidden = !isSkip(settings.prev.action);
  $('capMode').value = settings.capture.mode;
  $('capTime').hidden = settings.capture.mode !== 'time';
  $('capParas').hidden = settings.capture.mode !== 'paras';
  $('lockSeek').value = settings.lockSeek ? 'skip' : 'track';
  $('bgQuotes').checked = settings.bgQuotes;
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
