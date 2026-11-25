// Naming the audio's chapters from the book's contents, by listening to the start of each.

import { transcribeAround } from './audio/listen.js';
import { probing } from './figures.js';
import { renderInfo, setChapStatus } from './info.js';
import { crumb, lastCrash, log } from './log.js';
import { renderMarks } from './marks.js';
import { cur, renderTime } from './player.js';
import { queueBusy, runQueue } from './queue.js';
import { modelState, transcribe, warmModel } from './speech.js';
import { canWork, save } from './state.js';
import { entryAt, findInBook } from './text/book.js';
import { audio } from './ui/dom.js';

export const keepAudioChapters = (b) => { if (!b.audioChapters) b.audioChapters = b.chapters.map((c) => ({ start: c.start, title: c.title })); };
export function chaptersChanged() {
  save(true); renderInfo();
  renderTime(audio.currentTime || cur.book.position || 0); renderMarks();
}

// Names chapters from the book's contents list. The audio file knows when
// each chapter starts but often not what it is called; the EPUB knows the
// names but not the times. Listening to the first seconds of each chapter
// and finding those words in the text connects the two.
//
// It runs from the button in About this book, and once by itself for each
// book that has both chapters and a contents list (see autoNameChapters).
export let naming = false;   // listening to a chapter right now: other listening waits
let pass = null;             // the whole run through the chapters, while it lasts
export const namingChapters = () => !!pass;
const LISTEN = 25;        // seconds heard at the start of each chapter
const NEAR_START = 1500;  // characters: how close to a contents entry counts as its beginning
const rest = (ms) => new Promise((r) => setTimeout(r, ms));

export function nameChapters() { return startPass(false); }
function startPass(auto) {
  if (pass || !cur || !cur.text || !cur.source) return pass;
  pass = run(auto).finally(() => { pass = null; renderInfo(); });   // the button is usable again
  renderInfo();   // …and not while this runs
  return pass;
}

// The automatic run: once per book, as soon as the book has chapters, a
// contents list, its text and audio loaded, and the speech model can be used.
// b.autoNaming is the next chapter to listen to, or 'done'. Progress is kept
// after each chapter, so a run cut short (the app closed, or put away) picks
// up where it stopped. Called whenever the bookmark queue finishes.
export function autoNameChapters() {
  if (pass || !cur || !cur.text || !cur.source || !canWork() || modelState === 'failed' || lastCrash) return;
  const b = cur.book;
  if (b.autoNaming === 'done' || (b.chapters || []).length < 2 || !cur.meta.toc.length) return;
  startPass(true);
}

async function run(auto) {
  const mine = cur, b = mine.book;
  const say = (msg) => { if (cur === mine) setChapStatus(msg); };
  let named = 0, from = auto ? Number(b.autoNaming) || 0 : 0, finished = false;
  if (auto) log('naming chapters from the contents' + (from ? ', from chapter ' + (from + 1) : ''));
  try {
    await warmModel();
    for (let i = from; ; i++) {
      if (cur !== mine) break;
      if (i >= b.chapters.length) { finished = true; break; }
      // Bookmarks come first: any waiting are handled between chapters.
      if (auto && b.marks.some((m) => m.status === 'pending')) await runQueue();
      while (cur === mine && (queueBusy || probing)) { say('Waiting for bookmarks to finish…'); await rest(500); }
      if (cur !== mine || (auto && !canWork())) break;   // put away: carries on when back
      const ch = b.chapters[i];
      if (ch.src !== 'you') {
        say((auto ? 'Naming chapters from the book’s contents: ' : 'Listening to the start of chapter ') + (i + 1) + ' of ' + b.chapters.length + '…');
        let r;
        naming = true;
        try {
          r = await transcribeAround(mine.source, ch.start + LISTEN, LISTEN, 0, transcribe, (stage) => crumb(stage && 'naming chapters: ' + stage));
        } finally { naming = false; crumb(null); }
        const loc = findInBook(mine.text, r.words, 0);
        const at = loc && mine.text.starts.length ? mine.text.starts[Math.min(loc.start, mine.text.starts.length - 1)] : null;
        const entry = at == null ? null : entryAt(mine.meta.toc, at + 200);
        if (entry && at - entry.at <= NEAR_START && entry.label !== ch.title) {
          keepAudioChapters(b);
          ch.title = entry.label; ch.src = 'text'; named++;
          if (cur === mine) chaptersChanged();   // shows the new name straight away
        }
      }
      if (auto) { b.autoNaming = i + 1; save(true); }
    }
    if (finished) {
      if (auto) { b.autoNaming = 'done'; save(true); log('chapters named: ' + named); }
      say(named ? 'Named ' + named + (named === 1 ? ' chapter' : ' chapters') + ' from the book’s contents. The rest start partway through a section, so they keep their audio names.'
        : 'No chapter starts lined up with the book’s contents, so nothing was changed.');
    } else if (auto) say('');
  } catch (err) {
    say('Stopped: ' + ((err && err.message) || err));
  }
  crumb(null);
  if (cur === mine) chaptersChanged();
  runQueue();
}
