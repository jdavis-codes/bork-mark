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
// How the notes are voiced. Each style may change the pitch and length of a
// note and shapes its wave and its fade: `wave(x)` takes the position in the
// cycle (0 to 1) and `fade(k, len)` the sample's place in the note.
const sine = (x) => Math.sin(2 * Math.PI * x);
const VOICES = {
  chime: { pitch: 1, stretch: 1, wave: sine, fade: (k, len) => Math.min(1, k / 200, (len - k) / 400) },
  soft: { pitch: 0.5, stretch: 1.5, wave: sine, fade: (k, len) => Math.min(1, k / 700, (len - k) / 1100) },
  bell: { pitch: 1, stretch: 2.2, wave: (x) => (sine(x) + 0.5 * sine(2 * x) + 0.25 * sine(3 * x)) / 1.75, fade: (k, len) => Math.min(1, k / 60) * Math.exp(-4 * k / len) },
  click: { pitch: 1.6, stretch: 0.28, wave: (x) => (sine(x) > 0 ? 0.6 : -0.6), fade: (k, len) => Math.min(1, k / 20, (len - k) / 60) },
};
// Which setting names each sound's voice.
const WHEN = { mark: 'soundMark', fwd: 'soundSkip', back: 'soundSkip', figure: 'soundFigure' };
// The voice chosen for a sound, or 'none'. Settings saved when there was one
// style for everything, and a switch per event, are read as they were meant.
function voiceOf(key) {
  const v = settings[WHEN[key]];
  if (v === false) return 'none';
  return typeof v === 'string' ? v : settings.soundStyle || 'chime';
}
function toneWav(notes, name) {
  const rate = 22050, gap = 0.03, voice = VOICES[name] || VOICES.chime;
  // Loudness 50 is the level the tones always had.
  const level = 0.6 * Math.max(10, Math.min(100, settings.soundVolume || 50)) / 100;
  const lengths = notes.map(([, ms]) => Math.max(1, Math.floor(rate * ms * voice.stretch / 1000)));
  const { buf, v } = wav(rate, lengths.reduce((sum, len) => sum + len + Math.floor(rate * gap), 0), 16);
  let at = 0;
  notes.forEach(([freq], n) => {
    const len = lengths[n], f = freq * voice.pitch;
    for (let k = 0; k < len; k++) v.setInt16(44 + (at + k) * 2, Math.round(voice.wave((f * k / rate) % 1) * voice.fade(k, len) * level * 32767), true);
    at += len + Math.floor(rate * gap);
  });
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
    const a = fx[key] || (fx[key] = new Audio(URL.createObjectURL(toneWav(SOUNDS[key], voiceOf(key)))));
    a.preload = 'auto'; a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }, () => { a.muted = false; fxReady = false; });
  }
}
// A sound or the loudness changed: make the tones again, and play one to hear it.
// Called from a tap in Settings, which is also what lets iOS play them later.
export function retuneSounds(preview) {
  for (const key of Object.keys(SOUNDS)) {
    const a = fx[key] || (fx[key] = new Audio());
    if (a.src) URL.revokeObjectURL(a.src);
    a.src = URL.createObjectURL(toneWav(SOUNDS[key], voiceOf(key)));
    a.preload = 'auto'; a.muted = false;
  }
  fxReady = false;   // the silent first play happens again at the next press of play
  if (preview && fx[preview] && voiceOf(preview) !== 'none') fx[preview].play().catch(() => {});
}
export function sound(key) {
  const a = fx[key];
  if (!settings.sounds || !a || voiceOf(key) === 'none') return;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play();
  if (p) p.catch((e) => log('sound "' + key + '" did not play: ' + e.name));
}
