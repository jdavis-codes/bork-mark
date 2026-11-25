// A small notice with a spinner, shown for as long as something is being read or worked out in
// the background: a book's text or audio being loaded, the speech model, chapters being named.

import { $ } from './dom.js';

const jobs = new Map();
let seq = 0;
function render() {
  const labels = [...jobs.values()];
  $('busy').hidden = !labels.length;
  // The newest job names the notice; a count says when others are running too.
  $('busyText').textContent = labels.length ? labels[labels.length - 1] + (labels.length > 1 ? ' (+' + (labels.length - 1) + ')' : '') : '';
}
// Shows the notice with this label until the returned function is called.
export function busy(label) {
  const id = ++seq;
  jobs.set(id, label);
  render();
  return () => { jobs.delete(id); render(); };
}
// The notice for as long as a promise takes, whichever way it ends.
export function busyWhile(label, promise) {
  const done = busy(label);
  promise.then(done, done);
  return promise;
}
