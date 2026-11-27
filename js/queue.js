// The bookmark queue: finds each new bookmark's quote by listening to the audio around it.

import { transcribeAround } from './audio/listen.js';
import { autoNameChapters, naming } from './chapter-names.js';
import { probing } from './figures.js';
import { crumb, detail, log } from './log.js';
import { renderMarks } from './marks.js';
import { cur } from './player.js';
import { applyQuote } from './quotes.js';
import { modelState, setQueueStatus, transcribe, warmModel } from './speech.js';
import { canWork, save, settings } from './state.js';

const LOCATE_BEFORE = 45, LOCATE_AFTER = 15;   // seconds of audio used to find the place when capturing by paragraph

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
        const r = await transcribeAround(mine.source, m.t,
          settings.capture.mode === 'time' ? settings.capture.before : LOCATE_BEFORE,
          settings.capture.mode === 'time' ? settings.capture.after : LOCATE_AFTER, transcribe, crumb);
        m.words = r.words; m.split = r.split; m.transcript = r.transcript;
        if (mine.text) applyQuote(m, mine.text); else m.status = 'transcribed';
        detail('quote: ' + m.status + (m.confidence != null ? ', confidence ' + m.confidence.toFixed(2) : '') + ', ' + r.words.length + ' words heard');
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
