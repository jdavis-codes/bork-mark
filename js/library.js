// The library screen: one row per book.

import { cur, prepareBook } from './player.js';
import { save, state } from './state.js';
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

// A book without a cover shows Borky on its own colour, so several such books
// can be told apart. hueOf gives that colour's hue; freeHue picks a new book's,
// as far as it can from the hues the other books already have.
export function hueOf(b) {
  if (b.hue != null) return b.hue;
  let h = 0;
  for (const c of b.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
export function freeHue(books) {
  const taken = books.map(hueOf);
  let best = Math.floor(Math.random() * 360), far = -1;
  for (let h = 0; h < 360; h += 5) {
    const near = taken.reduce((m, t) => Math.min(m, Math.abs(((h - t + 540) % 360) - 180)), 180);
    if (near > far) { far = near; best = h; }
  }
  return taken.length ? best : Math.floor(Math.random() * 72) * 5;
}

// Stores a book's cover, new or in place of the old one, and shows it in its library row. Resolves to its address.
export async function setCover(b, blob) {
  await store('write', b.id, 'cover', blob);
  await store('remove', b.id, 'cover-display');   // the old cover's smaller copy
  b.hasCover = true;
  save(true);
  forgetCover(b.id);
  const u = await coverUrl(b);
  const r = libRows.get(b.id);
  if (u && r) r.img.src = u;
  return u;
}

const libRows = new Map();   // book id -> { li, img, name, meta, fill }
function libRow(b) {
  const r = { li: el('li'), img: el('img', 'thumb'), name: el('div', 'name'), meta: el('div', 'muted'), fill: el('div') };
  const btn = el('button', 'book'), info = el('div'), bar = el('div', 'bar');
  r.img.alt = '';
  r.img.style.setProperty('--hue', hueOf(b));
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
    if (usage != null && quota) {
      // "312 MB / 38 GB", and a pie that always shows at least a sliver once anything is stored.
      const size = (bytes) => (bytes < 1e9 ? Math.round(bytes / 1048576) + ' MB' : (bytes / 1073741824).toFixed(bytes < 1e10 ? 1 : 0) + ' GB');
      $('storageText').textContent = size(usage) + ' / ' + size(quota);
      $('storagePie').style.setProperty('--used', (usage ? Math.max(4, 100 * usage / quota) : 0).toFixed(1) + '%');
      $('storage').setAttribute('aria-label', size(usage) + ' of ' + size(quota) + ' of storage used');
      $('storage').hidden = false;
    }
  }
}
