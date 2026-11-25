// Bork Mark: starts the app. Each part lives in its own module under js/;
// importing them wires up their buttons. What runs at launch is below.

import { showIntro } from './js/intro.js';
import { renderLibrary } from './js/library.js';
import { detail, lastCrash, mb } from './js/log.js';
import { renderSettings } from './js/settings-sheet.js';
import { retryModel, warmModel } from './js/speech.js';
import { save, state } from './js/state.js';
import { $ } from './js/ui/dom.js';
import { autoUpdate } from './js/updates.js';

// The screens and sheets: importing each one wires up its buttons.
import './js/add-book.js';
import './js/book-files.js';
import './js/figures.js';
import './js/info.js';
import './js/marks.js';
import './js/player.js';
import './js/screens.js';
import './js/sleep.js';
import './js/theme.js';
import './js/trim.js';
import './js/viewer.js';

autoUpdate();
renderSettings();

// A bookmark that was mid-transcription when the app closed is not retried
// automatically: if it crashed the app once, it would do so on every launch.
for (const b of state.books) {
  for (const m of b.marks) {
    if (m.status === 'working') { m.status = 'error'; m.error = 'The app closed while finding this quote. Tap Retry to try again.'; }
  }
  // Likewise naming chapters by itself; the button in About this book still works.
  if (lastCrash && /^naming chapters/.test(lastCrash.stage) && typeof b.autoNaming === 'number') b.autoNaming = 'done';
}
save(true);

if (lastCrash) {
  $('crashNote').hidden = false;
  $('crashText').textContent = 'Last time, the app closed unexpectedly while ' + lastCrash.stage
    + (lastCrash.playing ? ' (audio was playing).' : '.') + ' Bookmarks are safe; any unfinished quote has a Retry button.';
}
$('crashDismiss').addEventListener('click', () => { $('crashNote').hidden = true; });
$('modelAgain').addEventListener('click', retryModel);
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
if (navigator.storage && navigator.storage.estimate) {
  navigator.storage.estimate().then(({ usage, quota }) => detail('launch: ' + state.books.length + ' books, storage ' + mb(usage || 0) + ' of ' + mb(quota || 0)
    + ', ' + (navigator.hardwareConcurrency || '?') + ' cores, screen ' + screen.width + '×' + screen.height + ' @' + devicePixelRatio)).catch(() => {});
}
if (!state.books.length && !state.introSeen && !lastCrash) showIntro();
