// The library screen: one row per book.

import { cur, openBook } from './player.js';
import { morph } from './screens.js';
import { state } from './state.js';
import { stored } from './storage.js';
import { $, el, fmt, setFill, setText } from './ui/dom.js';

// Each book's row is built once and then only updated, so its cover is not
// read and decoded again every time the library shows, which happens at the
// start of every swipe down from the player.
// One address (object URL) per book's cover, shared by the library, the
// player and the mini player. An image already on screen is then never loaded
// again under a new address, which on Safari made the cover blink as a book
// opened. The library owns them: they are let go when the book is removed.
const covers = new Map();   // book id -> promise of the address, or of null
export function coverUrl(b) {
  if (!b.hasCover) return Promise.resolve(null);
  if (!covers.has(b.id)) covers.set(b.id, stored(b.id, 'cover').then((f) => (f ? URL.createObjectURL(f) : null)));
  return covers.get(b.id);
}
function forgetCover(id) {
  const p = covers.get(id);
  covers.delete(id);
  if (p) p.then((u) => { if (u) URL.revokeObjectURL(u); });
}

const libRows = new Map();   // book id -> { li, img, name, meta, fill }
function libRow(b) {
  const r = { li: el('li'), img: el('img', 'thumb'), name: el('div', 'name'), meta: el('div', 'muted'), fill: el('div') };
  const btn = el('button', 'book'), info = el('div'), bar = el('div', 'bar');
  r.img.alt = '';
  bar.append(r.fill); info.append(r.name, r.meta, bar);
  btn.append(r.img, info); r.li.append(btn);
  // The tapped cover grows into the player's cover. If this book is the
  // one in the mini player, that cover is the one that grows instead.
  btn.addEventListener('click', () => morph(() => openBook(b.id), cur && cur.book === b ? null : r.img));
  coverUrl(b).then((u) => { if (u && libRows.get(b.id) === r) r.img.src = u; });
  return r;
}
export async function renderLibrary() {
  const ul = $('books');
  $('emptyLib').hidden = state.books.length > 0;
  for (const [id, r] of libRows) {
    if (state.books.some((b) => b.id === id)) continue;
    r.li.remove(); forgetCover(id); libRows.delete(id);
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
