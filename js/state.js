// Saved state: the library (books and their bookmarks) and settings, kept in localStorage.

import { toast } from './ui/dom.js';
import { CHANNEL } from './version.js';

// The development copy lives at the same web address as the released one, so
// it keeps its books and settings under different names.
export const NS = CHANNEL === 'dev' ? 'dev.' : '';
const KEY = 'borkmark.' + NS + 'v1';

// ---------- saved state ----------
export let state = { books: [] };
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved && Array.isArray(saved.books)) state = saved;
} catch (e) { /* storage unavailable: run without persistence */ }

// A book's details can come from four places. In order of trust: typed by
// you, the book text (EPUB), the audio file's tags, the file name.
export const META = ['title', 'author', 'publisher', 'year'];
export const fromDoc = (doc) => (doc ? Object.fromEntries(META.map((f) => [f, doc[f] || ''])) : {});
export function resolveMeta(b) {
  b.edited = b.edited || {}; b.fromText = b.fromText || {}; b.src = b.src || {};
  // Books added before sources were tracked only have the audio's values.
  b.fromAudio = b.fromAudio || { title: b.title || '', author: b.author || '' };
  for (const f of META) {
    const pick = b.edited[f] ? 'you' : b.fromText[f] ? 'text' : b.fromAudio[f] ? 'audio' : 'file';
    b.src[f] = pick;
    b[f] = pick === 'you' ? b.edited[f] : pick === 'text' ? b.fromText[f] : pick === 'audio' ? b.fromAudio[f]
      : f === 'title' ? (b.audioName || 'Untitled').replace(/\.[^.]+$/, '') : '';
  }
}
state.books.forEach(resolveMeta);
state.trash = state.trash || [];   // Recently deleted (trash.js)

// What each button does. `next` and `prev` are the track buttons a headset or
// watch sends; an action is mark | fwd | back | nextChapter | prevChapter | none.
export const DEFAULTS = {
  next: { action: 'mark', secs: 30 },
  prev: { action: 'mark', secs: 30 },
  skipBack: 30, skipFwd: 30,     // on-screen and lock-screen skip buttons
  lockSeek: true,                // lock screen shows skip buttons rather than track buttons
  bgQuotes: false,               // find quotes while the phone is locked
  sounds: true,                  // short tones for bookmark, skip and figures
  soundVolume: 50,               // loudness of the tones, 10 to 100
  // The sound for each event: chime | soft | bell | click | none.
  soundMark: 'chime',            // a bookmark
  soundSkip: 'chime',            // a skip from the headphones, watch or lock screen
  soundFigure: 'chime',          // reaching a picture or table
  figAlert: true,                // chime when the narration reaches a picture or table
  figPause: false,               // …and pause there
  // What a bookmark captures: seconds of audio either side, or whole paragraphs.
  capture: { mode: 'time', before: 45, after: 15, parasBefore: 1, parasAfter: 1 },
  trimSnap: true,                // trimming: ends settle on whole sentences
  citeStyle: 'simple',           // simple | mla | apa | chicago
  citeTime: true,                // citations end with the place in the audio
  citeTimeText: 'audiobook, {time}',
  markOrder: 'book',             // bookmarks list: book | new | old | long | short | attention (see ORDERS in marks.js)
  accent: null,                  // custom accent color as #rrggbb, or null for the default green
  trashDays: 10,                 // days deleted books and bookmarks are kept (trash.js); 0: until emptied
};
export const settings = state.settings = {
  ...DEFAULTS, ...(state.settings || {}),
  next: { ...DEFAULTS.next, ...((state.settings || {}).next || {}) },
  prev: { ...DEFAULTS.prev, ...((state.settings || {}).prev || {}) },
  capture: { ...DEFAULTS.capture, ...((state.settings || {}).capture || {}) },
};
export const canWork = () => document.visibilityState !== 'hidden' || settings.bgQuotes;
let saveTimer = null;
export function save(now) {
  const write = () => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('Not saved: storage is full', 'warn'); }
  };
  if (now) { clearTimeout(saveTimer); write(); } else if (!saveTimer) saveTimer = setTimeout(write, 4000);
}
