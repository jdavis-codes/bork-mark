// Generated sounds: short confirmation tones, and a silent loop that keeps the iOS audio
// session alive across a pause.

import { log } from './log.js';
import { settings } from './state.js';

// Installed to the home screen, iOS will not let the app restart audio from
// the lock screen once it has fully paused: the player reports "playing" but
// stays silent until the app is opened. Playing a silent loop alongside keeps
// the audio session open across a pause, so play works again from the lock
// screen. It stops itself after a while so a forgotten pause costs no battery.
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const KEEP_ALIVE_MS = 15 * 60 * 1000;
let keep = null, keepTimer = null;
export let keepOn = false;
// A mono PCM WAV file of n samples, 8 or 16 bits. Returns the buffer and a
// view on it; the samples start at byte 44.
function wav(rate, n, bits) {
  const bytes = bits / 8, buf = new ArrayBuffer(44 + n * bytes), v = new DataView(buf);
  const str = (o, t) => { for (let k = 0; k < t.length; k++) v.setUint8(o + k, t.charCodeAt(k)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * bytes, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * bytes, true); v.setUint16(32, bytes, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, n * bytes, true);
  return { buf, v };
}
function silentWav(seconds) {
  const rate = 8000, { buf } = wav(rate, rate * seconds, 8);
  new Uint8Array(buf, 44).fill(128);   // 8-bit silence is the midpoint
  return new Blob([buf], { type: 'audio/wav' });
}
export function keepAlive(on) {
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
// After a pause, the silent loop runs on for a while, then stops.
export function keepAliveLater() {
  if (keepOn) keepTimer = setTimeout(() => keepAlive(false), KEEP_ALIVE_MS);
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
  const { buf, v } = wav(rate, Math.ceil(rate * total), 16);
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
export function primeSounds() {
  if (fxReady || !settings.sounds) return;
  fxReady = true;
  for (const key of Object.keys(SOUNDS)) {
    const a = fx[key] || (fx[key] = new Audio(URL.createObjectURL(toneWav(SOUNDS[key]))));
    a.preload = 'auto'; a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }, () => { a.muted = false; fxReady = false; });
  }
}
export function sound(key) {
  const a = fx[key];
  if (!settings.sounds || !a) return;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play();
  if (p) p.catch((e) => log('sound "' + key + '" did not play: ' + e.name));
}
