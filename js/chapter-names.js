// Naming the audio's chapters from the book's contents, by listening to the start of each.

import { transcribeAround } from './audio/listen.js';
import { probing } from './figures.js';
import { renderInfo, setChapStatus } from './info.js';
import { crumb } from './log.js';
import { renderMarks } from './marks.js';
import { cur, renderTime } from './player.js';
import { queueBusy, runQueue } from './queue.js';
import { transcribe, warmModel } from './speech.js';
import { save } from './state.js';
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
export let naming = false;
const LISTEN = 25;        // seconds heard at the start of each chapter
const NEAR_START = 1500;  // characters: how close to a contents entry counts as its beginning
export async function nameChapters() {
  if (naming || !cur || !cur.text || !cur.source) return;
  const mine = cur, b = mine.book;
  const say = (msg) => { if (cur === mine) setChapStatus(msg); };
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
