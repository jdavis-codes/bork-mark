// Diagnostics: a rolling log of button presses and player events, and crash breadcrumbs.

import { NS } from './state.js';
import { audio } from './ui/dom.js';

// A short rolling record of button presses and player events, kept on the
// device and copyable from Settings, for working out problems after the fact.
const LOGKEY = 'borkmark.' + NS + 'log';
export let logLines = [];
try { logLines = JSON.parse(localStorage.getItem(LOGKEY)) || []; } catch (e) {}
// Written to storage in batches: a burst of player events costs one write.
// Flushed straight away when the page is hidden, which is when iOS may end it.
let logTimer = null;
export function flushLog() {
  clearTimeout(logTimer); logTimer = null;
  try { localStorage.setItem(LOGKEY, JSON.stringify(logLines)); } catch (e) {}
}
export function log(msg) {
  const d = new Date();
  const stamp = d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  logLines.push(stamp + (document.visibilityState === 'hidden' ? ' [bg] ' : ' ') + msg);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  if (document.visibilityState === 'hidden') flushLog();
  else if (!logTimer) logTimer = setTimeout(flushLog, 1000);
}
window.addEventListener('pagehide', flushLog);
log('--- app opened' + ((window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) ? ' (home screen)' : ' (browser)'));

// ---------- crash breadcrumbs ----------
// iOS kills a page that uses too much memory without any error we can catch.
// Noting the current heavy step lets the next launch say what was going on,
// and stops it from walking straight back into the same crash.
const CRUMB = 'borkmark.' + NS + 'crumb';
export let lastCrash = null;
try { lastCrash = JSON.parse(localStorage.getItem(CRUMB)); } catch (e) {}
export function crumb(stage) {
  if (stage) log('work: ' + stage);
  try {
    if (stage) localStorage.setItem(CRUMB, JSON.stringify({ stage, t: Date.now(), playing: !audio.paused }));
    else localStorage.removeItem(CRUMB);
  } catch (e) {}
}
crumb(null);
