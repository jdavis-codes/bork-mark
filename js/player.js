// The player: the open book (`cur`), playback, the clock and scrubber, the skip and track
// buttons, the speed and chapter lists, and the lock screen controls.

import { openAudio } from './audio/container.js';
import { loadBookText, loadPageScan } from './book-files.js';
import { loadExtras } from './extras.js';
import { forgetTrackPosition, renderFigTab, resetFigureTracking, showPendingFigure, trackFigures } from './figures.js';
import { renderInfo } from './info.js';
import { detail, log, mb } from './log.js';
import { addMark, renderMarks } from './marks.js';
import { runQueue } from './queue.js';
import { afterMotion, renderMini, showPlayer } from './screens.js';
import { checkSleep, setSleep, sleep } from './sleep.js';
import { keepAlive, keepAliveLater, keepOn, primeSounds, sound } from './sounds.js';
import { setQueueStatus } from './speech.js';
import { save, settings, state } from './state.js';
import { stored } from './storage.js';
import { $, audio, el, fillRange, fmt, setAttr, setText, toast } from './ui/dom.js';
import { setScroll } from './ui/marquee.js';
import { busyWhile } from './ui/busy.js';
import { closeSheet } from './ui/sheets.js';
import { renderSearchTab } from './search.js';
import { coverUrl } from './library.js';

// ---------- player ----------
// iOS gives .m4b files no usable MIME type, and Safari won't play a blob
// without one, so label the blob from its first bytes.
async function playable(f) {
  const h = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...h.subarray(4, 8)) === 'ftyp') return f.slice(0, f.size, 'audio/mp4');
  if ((h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return f.slice(0, f.size, 'audio/mpeg');
  return f;
}

export let cur = null;   // { book, source, text, audioUrl, coverUrl }
let scrubbing = false;

const chaptersOf = (b) => (b.chapters && b.chapters.length ? b.chapters : [{ start: 0, title: '' }]);
export function chapterAt(b, t) {
  const ch = chaptersOf(b);
  let i = 0;
  while (i + 1 < ch.length && ch[i + 1].start <= t + 0.25) i++;
  return { i, start: ch[i].start, end: i + 1 < ch.length ? ch[i + 1].start : b.duration, title: ch[i].title, count: ch.length };
}

export async function openBook(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  if (cur && cur.book === book) { showPlayer(); return; }   // already loaded, maybe playing
  const file = await stored(id, 'audio');
  if (!file) { toast('The audio for this book is missing from this device'); return; }
  closeBook();
  cur = { book, source: null, text: null, meta: { toc: [], pages: [], figures: [] }, pageSrc: null, audioUrl: null, coverUrl: null, openedAt: Date.now() };
  detail('opening ' + book.title + ': audio ' + mb(file.size));
  showPlayer();
  setScroll($('title'), book.title);
  $('author').textContent = book.author;
  $('playerError').hidden = true;
  renderInfo();
  renderSpeed();
  // The cover, at the same address the library shows it at (see coverUrl), so
  // it is already drawn and nothing replaces it later.
  cur.coverUrl = await coverUrl(book);
  if (cur.coverUrl) $('cover').src = cur.coverUrl; else $('cover').removeAttribute('src');
  cur.audioUrl = URL.createObjectURL(await playable(file));
  audio.src = cur.audioUrl;
  audio.playbackRate = book.speed || 1;
  renderTime(book.position || 0);
  renderMarks(); setMediaSession(); renderFigTab(); renderSearchTab();

  // The rest is heavy (the text's word index, the audio's index) and can wait
  // until the player has finished sliding in.
  const mine = cur;
  afterMotion(() => {
    if (cur !== mine) return;
    busyWhile('Reading the audio…', openAudio(file)).then((s) => { if (cur === mine) { mine.source = s; runQueue(); } })
      .catch((e) => { if (cur === mine) setQueueStatus('Cannot read this audio for quotes: ' + e.message); });
    if (book.hasText) busyWhile('Loading the book text…', loadBookText(mine));
    if (book.pageSrcName) busyWhile('Loading the page scan…', loadPageScan(mine));
    if (book.hasExtras) loadExtras(mine);
  });
}

export function closeBook() {
  if (!cur) return;
  setSleep(null);
  resetFigureTracking();
  wantPlaying = false; clearTimeout(playCheck);
  audio.pause();
  keepAlive(false);
  cur.book.position = audio.currentTime || cur.book.position || 0;
  save(true);
  audio.removeAttribute('src'); audio.load();
  if (cur.audioUrl) URL.revokeObjectURL(cur.audioUrl);
  cur = null;
  renderMini();
}

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
audio.addEventListener('seeked', forgetTrackPosition);
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
  const pie = $('pie'), p = (frac * 100).toFixed(1);
  if (pie.style.getPropertyValue('--p') !== p) pie.style.setProperty('--p', p);
  setText($('overallText'), Math.floor(frac * 100) + '% · ' + leftText);
  setAttr($('overall'), 'aria-label', Math.floor(frac * 100) + ' percent of the book, ' + leftText);
}

export function renderTime(t) {
  const b = cur.book, c = chapterAt(b, t);
  const label = c.count > 1 ? c.title : 'Whole book';
  setScroll($('chapterText'), label);
  if ($('chapterBtn').disabled !== (c.count <= 1)) $('chapterBtn').disabled = c.count <= 1;
  // The slider moves in whole seconds, so it is only touched when that changes.
  const s = $('scrub'), min = String(Math.floor(c.start)), max = String(Math.max(Math.floor(c.start) + 1, Math.ceil(c.end)));
  if (s.min !== min || s.max !== max || s.value !== String(Math.round(t))) { s.min = min; s.max = max; s.value = t; fillRange(s); }
  setText($('elapsed'), fmt(t - c.start));
  setText($('remaining'), '−' + fmt(c.end - t));
  renderOverall(t);
}
export function seek(t) {
  if (!cur) return;
  t = Math.max(0, Math.min(cur.book.duration - 0.5, t));
  cur.book.position = t;
  try { audio.currentTime = t; } catch (e) {}
  renderTime(t);
}
$('scrub').addEventListener('input', () => {
  scrubbing = true;
  const t = Number($('scrub').value), c = chapterAt(cur.book, audio.currentTime);
  setText($('elapsed'), fmt(t - c.start));
  setText($('remaining'), '−' + fmt(c.end - t));
  renderOverall(t);
});
$('scrub').addEventListener('change', () => { scrubbing = false; seek(Number($('scrub').value)); });

// Starts playback, and checks a few seconds later that audio is really
// moving. Safari can report "playing" while nothing comes out.
let wantPlaying = false, playCheck = null;
export function play(isRetry) {
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
export function pause() {
  wantPlaying = false;
  clearTimeout(playCheck);
  audio.pause();
  keepAliveLater();
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
export function setMediaSession() {
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
