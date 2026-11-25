// The library screen: one row per book.

import { cur, prepareBook } from './player.js';
import { state } from './state.js';
import { store, stored } from './storage.js';
import { $, el, fmt, setFill, setText } from './ui/dom.js';
import { detail } from './log.js';
import { openPlayer } from './screens.js';

// Each book's row is built once and then only updated, so its cover is not
// read and decoded again every time the library shows, which happens at the
// start of every swipe down from the player.
// One address (object URL) per book's cover, shared by the library, the
// player and the mini player. An image already on screen is then never loaded
// again under a new address, which on Safari made the cover blink as a book
// opened. The library owns them: they are let go when the book is removed.
//
// The address is of a display-size copy (COVER_MAX across, made once and kept
// with the book). Covers in audiobook files run to 3000 px, and Safari, which
// decodes a big image the first time it is drawn at a size, showed the player's
// cover blank for a moment after the screen slid in while it did.
const COVER_MAX = 1024;
const covers = new Map();   // book id -> promise of the address, or of null
export function coverUrl(b) {
  if (!b.hasCover) return Promise.resolve(null);
  if (!covers.has(b.id)) covers.set(b.id, displayCover(b).then((f) => (f ? URL.createObjectURL(f) : null)));
  return covers.get(b.id);
}
async function displayCover(b) {
  const kept = await stored(b.id, 'cover-display');
  if (kept) return kept;
  const f = await stored(b.id, 'cover');
  if (!f) return null;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, COVER_MAX / Math.max(bmp.width, bmp.height));
    if (k === 1) { bmp.close(); return f; }   // small enough already
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const small = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!small) return f;
    store('write', b.id, 'cover-display', small).catch(() => {});
    detail('cover made display size: ' + Math.round(f.size / 1024) + ' KB → ' + Math.round(small.size / 1024) + ' KB, ' + c.width + '×' + c.height);
    return small;
  } catch (e) {
    return f;   // can't be read as an image here: show it as it is
  }
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
  btn.addEventListener('click', async () => {
    const show = await prepareBook(b.id);   // ready first, then the screen changes at once
    if (show) openPlayer(show, cur && cur.book === b && !$('mini').hidden ? $('miniCover') : r.img);
  });
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
