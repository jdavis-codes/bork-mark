// The bookmark queue: finds each new bookmark's quote by listening to the audio around it.

import { transcribeAround } from './audio/listen.js';
import { autoNameChapters, naming } from './chapter-names.js';
import { probing } from './figures.js';
import { crumb, detail, log } from './log.js';
import { renderMarks } from './marks.js';
import { cur } from './player.js';
import { applyPlace, applyQuote } from './quotes.js';
import { modelState, setQueueStatus, transcribe, warmModel } from './speech.js';
import { canWork, save, settings } from './state.js';
import { findInBook } from './text/book.js';

const LOCATE_BEFORE = 45, LOCATE_AFTER = 15;   // seconds of audio used to find the place when capturing by paragraph

// ---------- a long capture, from its ends ----------
// With the book's text, a quote is the text between where the capture starts
// and where it ends, so only those two places need to be heard: a piece at
// the start, the piece around the bookmark, and (when much comes after the
// bookmark) a piece at the end. A three-minute capture is then a minute of
// listening instead of three: a third of the time, and the memory of a short
// clip (a 195 s clip peaked about 150 MB above a 15 s one, which is when iOS
// ended the app). It also places the ends better: over hundreds of words the
// narration and the text drift apart, and the matcher follows one offset.
const PIECE = 30;          // seconds heard at each place: one window of the speech model
const WORTH = 30;          // only when it saves at least this much listening
const RATE = [0.8, 6];     // words a second between the ends that a narrator could plausibly read
// The bookmark's place in the text, or null to listen to the whole capture
// instead (too short to gain, or an end that couldn't be placed).
async function placeFromEnds(mine, m, before, after) {
  const a = Math.max(0, m.t - before), z = Math.min(mine.book.duration || Infinity, m.t + after);
  const tailToo = z - m.t > PIECE - 10;   // the end is too far past the bookmark for one piece to hold both
  if (z - a < PIECE * (tailToo ? 3 : 2) + WORTH) return null;
  const hear = async (T, back, fwd) => {
    const r = await transcribeAround(mine.source, T, back, fwd, transcribe, crumb);
    return findInBook(mine.text, r.words, r.split);
  };
  const head = await hear(a, 0, PIECE);
  const mid = head && await hear(m.t, tailToo ? PIECE / 2 : PIECE - (z - m.t), tailToo ? PIECE / 2 : z - m.t);
  const tail = mid && (tailToo ? await hear(z, PIECE, 0) : mid);
  const loc = tail && { start: head.start, split: mid.split, end: tail.end, confidence: Math.min(head.confidence, mid.confidence, tail.confidence) };
  const rate = loc && (loc.end - loc.start) / (z - a);
  if (!loc || loc.split < loc.start || loc.split > loc.end || rate < RATE[0] || rate > RATE[1]) {
    detail('quote: the ends of the capture were not placed' + (loc ? ' believably (' + rate.toFixed(1) + ' words a second)' : '') + ', listening to all of it');
    return null;
  }
  detail('quote: placed from its ends, ' + PIECE * (tailToo ? 3 : 2) + ' s heard of ' + Math.round(z - a) + ' s');
  return loc;
}

export let queueBusy = false;
export async function runQueue() {
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
        const byTime = settings.capture.mode === 'time';
        const before = byTime ? settings.capture.before : LOCATE_BEFORE, after = byTime ? settings.capture.after : LOCATE_AFTER;
        const place = mine.text ? await placeFromEnds(mine, m, before, after) : null;
        if (place) {
          applyPlace(m, place, mine.text);
          detail('quote: ' + m.status + ', confidence ' + m.confidence.toFixed(2));
        } else {
          const r = await transcribeAround(mine.source, m.t, before, after, transcribe, crumb);
          m.words = r.words; m.split = r.split; m.transcript = r.transcript;
          if (mine.text) applyQuote(m, mine.text); else m.status = 'transcribed';
          detail('quote: ' + m.status + (m.confidence != null ? ', confidence ' + m.confidence.toFixed(2) : '') + ', ' + r.words.length + ' words heard');
        }
      } catch (err) {
        m.status = 'error'; m.error = String((err && err.message) || err);
        log('quote failed: ' + m.error);
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
  autoNameChapters();
}
