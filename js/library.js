// The library screen: one row per book.

import { cur, openBook } from './player.js';
import { morph } from './screens.js';
import { state } from './state.js';
import { stored } from './storage.js';
import { $, el, fmt, setFill, setText } from './ui/dom.js';

// Each book's row is built once and then only updated, so its cover is not
// read and decoded again every time the library shows, which happens at the
// start of every swipe down from the player.
const libRows = new Map();   // book id -> { li, img, name, meta, fill, url }
function libRow(b) {
  const r = { li: el('li'), img: el('img', 'thumb'), name: el('div', 'name'), meta: el('div', 'muted'), fill: el('div'), url: null };
  const btn = el('button', 'book'), info = el('div'), bar = el('div', 'bar');
  r.img.alt = '';
  bar.append(r.fill); info.append(r.name, r.meta, bar);
  btn.append(r.img, info); r.li.append(btn);
  // The tapped cover grows into the player's cover. If this book is the
  // one in the mini player, that cover is the one that grows instead.
  btn.addEventListener('click', () => morph(() => openBook(b.id, r.img.getAttribute('src')), cur && cur.book === b ? null : r.img));
  if (b.hasCover) stored(b.id, 'cover').then((f) => {
    if (!f || libRows.get(b.id) !== r) return;
    r.url = URL.createObjectURL(f); r.img.src = r.url;
  });
  return r;
}
export async function renderLibrary() {
  const ul = $('books');
  $('emptyLib').hidden = state.books.length > 0;
  for (const [id, r] of libRows) {
    if (state.books.some((b) => b.id === id)) continue;
    r.li.remove(); if (r.url) URL.revokeObjectURL(r.url); libRows.delete(id);
  }
  state.books.forEach((b, k) => {
    let r = libRows.get(b.id);
    if (!r) libRows.set(b.id, (r = libRow(b)));
    const n = b.marks.length;
    setText(r.name, b.title);
    setText(r.meta, [b.author, fmt(b.duration), n ? n + (n === 1 ? ' bookmark' : ' bookmarks') : ''].filter(Boolean).join(' · '));
    setFill(r.fill, (b.position || 0) / (b.duration || 1));
    if (ul.children[k] !== r.li) ul.insertBefore(r.li, ul.children[k] || null);
  });
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage != null && quota) $('storage').textContent = 'Using ' + (usage / 1048576).toFixed(0) + ' MB of about ' + (quota / 1073741824).toFixed(1) + ' GB available to this app.';
  }
}
