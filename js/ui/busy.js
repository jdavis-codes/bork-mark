// A notice with a spinner, shown while something is being read or worked out in the background:
// a book's text or audio being loaded, the speech model, chapters being named.

import { $ } from './dom.js';

// Work that is over in a moment would only make the notice flicker, so it
// appears once something has been going on for WAIT, and then stays for at
// least SHOWN. Labels are two short words ("Loading text"), so they fit beside
// the title in the library even on a small phone.
const WAIT = 700, SHOWN = 900;
const jobs = new Map();
let seq = 0, showTimer = null, hideTimer = null, since = 0;
function paint() {
  // The newest job names the notice.
  $('busyText').textContent = [...jobs.values()].pop();
}
function show() {
  showTimer = null;
  if (!jobs.size) return;
  paint();
  since = Date.now();
  $('busy').hidden = false;
  document.documentElement.classList.add('is-busy');   // notifications move down to make room
}
function hide() {
  hideTimer = null;
  if (jobs.size) return;
  $('busy').hidden = true;
  document.documentElement.classList.remove('is-busy');
}
function update() {
  if (jobs.size) {
    clearTimeout(hideTimer); hideTimer = null;
    if (!$('busy').hidden) paint();
    else if (!showTimer) showTimer = setTimeout(show, WAIT);
  } else {
    clearTimeout(showTimer); showTimer = null;
    if (!$('busy').hidden && !hideTimer) hideTimer = setTimeout(hide, Math.max(0, SHOWN - (Date.now() - since)));
  }
}
// Shows the notice with this label until the returned function is called.
export function busy(label) {
  const id = ++seq;
  jobs.set(id, label);
  update();
  return () => { jobs.delete(id); update(); };
}
// The notice for as long as a promise takes, whichever way it ends.
export function busyWhile(label, promise) {
  const done = busy(label);
  promise.then(done, done);
  return promise;
}
