// Recently deleted: books and bookmarks are kept for a while after they're
// deleted (settings.trashDays, 10 unless changed; 0 keeps them until emptied)
// and can be put back from Settings. A deleted book keeps its files on the
// device until then. Only a launch deletes for good: whatever is past its
// time then goes, so a shorter setting never takes things away on the spot.

import { renderLibrary } from './library.js';
import { log } from './log.js';
import { renderMarks } from './marks.js';
import { cur } from './player.js';
import { save, settings, state } from './state.js';
import { store } from './storage.js';
import { $, el, fmt, icon, toast } from './ui/dom.js';

const DAY = 86400000;
const keep = () => (settings.trashDays > 0 ? settings.trashDays * DAY : Infinity);
const BOOK = 'M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2zM5 20a2 2 0 0 0 2 2h12v-4M9 8h6';
const MARK = 'M6 3h12v18l-6-4.5L6 21z';

// state.trash: [{ kind: 'book', book, at }] and [{ kind: 'mark', bookId, mark, at }], newest first.
export function trashBook(b) {
  state.trash.unshift({ kind: 'book', book: b, at: Date.now() });
  save(true);
}
export function trashMark(b, m) {
  state.trash.unshift({ kind: 'mark', bookId: b.id, mark: m, at: Date.now() });
  save(true);
}

// At launch: what has been here ten days goes for good, with a book's files.
export function purgeTrash() {
  const now = Date.now(), old = state.trash.filter((x) => now - x.at > keep());
  if (!old.length) return;
  for (const x of old) if (x.kind === 'book') store('remove', x.book.id).catch(() => {});
  const gone = new Set(old.filter((x) => x.kind === 'book').map((x) => x.book.id));
  // A bookmark whose book has gone for good can't be put back.
  state.trash = state.trash.filter((x) => !old.includes(x) && !(x.kind === 'mark' && gone.has(x.bookId)));
  save(true);
  log('recently deleted: ' + old.length + ' gone for good');
}

function restore(x) {
  state.trash.splice(state.trash.indexOf(x), 1);
  if (x.kind === 'book') {
    state.books.unshift(x.book);
  } else {
    let b = state.books.find((y) => y.id === x.bookId);
    if (!b) {
      // Its book was deleted too: that comes back with it.
      const box = state.trash.find((y) => y.kind === 'book' && y.book.id === x.bookId);
      if (!box) { save(true); renderTrash(); toast('Its book is gone for good', 'warn'); return; }
      state.trash.splice(state.trash.indexOf(box), 1);
      b = box.book; state.books.unshift(b);
    }
    b.marks.push(x.mark);
    if (cur && cur.book === b) renderMarks();
  }
  save(true);
  renderLibrary(); renderTrash();
  toast(x.kind === 'book' ? 'Book restored' : 'Bookmark restored');
}

function timeLeft(x) {
  if (keep() === Infinity) return 'kept until emptied';
  const days = Math.ceil((x.at + keep() - Date.now()) / DAY);
  return days <= 0 ? 'goes when the app next opens' : days + (days === 1 ? ' day left' : ' days left');
}
const titleOf = (id) => {
  const b = state.books.find((y) => y.id === id) || (state.trash.find((y) => y.kind === 'book' && y.book.id === id) || {}).book;
  return b ? b.title : 'a deleted book';
};

// The Settings section: one list for both, newest first.
export function renderTrash() {
  const list = $('trashList');
  list.textContent = '';
  for (const x of state.trash) {
    const li = el('li'), text = el('div', 'trashtext');
    const m = x.mark;
    const name = x.kind === 'book' ? x.book.title : '“' + (m.status === 'done' ? (m.before + m.after) : (m.transcript || '')).trim().slice(0, 90) + '”';
    const sub = (x.kind === 'book' ? 'Book' : titleOf(x.bookId) + ' · ' + fmt(m.t)) + ' · ' + timeLeft(x);
    text.append(el('span', 'trashname', name), el('span', 'muted', sub));
    const back = el('button', 'plain', 'Restore');
    back.addEventListener('click', () => restore(x));
    li.append(icon(x.kind === 'book' ? BOOK : MARK), text, back);
    list.append(li);
  }
  $('trashNote').hidden = state.trash.length > 0;
  $('trashEmpty').hidden = !state.trash.length;
}
$('trashEmpty').addEventListener('click', () => {
  const n = state.trash.length;
  if (!n || !confirm('Delete ' + (n === 1 ? 'this' : 'these ' + n) + ' for good? They can’t be brought back.')) return;
  for (const x of state.trash) if (x.kind === 'book') store('remove', x.book.id).catch(() => {});
  state.trash.length = 0;
  save(true);
  renderTrash();
  log('recently deleted: emptied (' + n + ')');
});
