// The open book's text and page scan: storing and loading them, and adding or replacing them
// from About this book.

import { renderFigTab } from './figures.js';
import { metaChanged, renderInfo } from './info.js';
import { renderMarks } from './marks.js';
import { cur } from './player.js';
import { runQueue } from './queue.js';
import { findPages, rematch, requote } from './quotes.js';
import { isOrnament } from './sources/epub.js';
import { readBook } from './sources/index.js';
import { buildPageIndex, guessFirstNumbered, pdfCover, readPdfPages } from './sources/pdf.js';
import { removeExtras } from './extras.js';
import { clearCover, setCover, TRASH } from './library.js';
import { fromDoc, resolveMeta, save } from './state.js';
import { store, stored } from './storage.js';
import { buildBook, findInBook, pageNumber, tokenize } from './text/book.js';
import { findTextTables, unwrapLines } from './text/cleanup.js';
import { busy } from './ui/busy.js';
import { $, toast } from './ui/dom.js';
import { showMenu } from './ui/menu.js';
import { detail, log, mb } from './log.js';
import { renderSearchTab } from './search.js';

// The book text, plus where its contents entries and print pages fall in it.
export async function storeText(id, doc) {
  await store('write', id, 'text', new Blob([doc.text], { type: 'text/plain' }));
  await store('write', id, 'meta', new Blob([JSON.stringify({ toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true, unwrapped: true, sized: true })], { type: 'application/json' }));
  for (let i = 0; i < doc.images.length; i++) await store('write', id, 'img-' + i, doc.images[i]);
}

// Loads the open book's text (and what was found in it) once the player is up.
export async function loadBookText(mine) {
  const book = mine.book, id = book.id, f = await stored(id, 'text');
  if (!f || cur !== mine) return;
  const meta = await stored(id, 'meta');
  if (meta) try { mine.meta = { toc: [], pages: [], figures: [], ...JSON.parse(await meta.text()) }; } catch (e) {}
  let bookText = await f.text();
  if (!mine.meta.unwrapped) {
    // Books added earlier may hold text with a line break at the end of every
    // printed line. Join those lines once, and keep the result.
    const joined = unwrapLines(bookText);
    mine.meta.unwrapped = true;
    if (joined !== bookText) {
      bookText = joined;
      store('write', id, 'text', new Blob([bookText], { type: 'text/plain' })).catch(() => {});
      mine.rewrap = true;
    }
    store('write', id, 'meta', new Blob([JSON.stringify(mine.meta)], { type: 'application/json' })).catch(() => {});
  }
  const t0 = performance.now();
  mine.text = buildBook(bookText);
  detail('book text ready: ' + mine.text.words.length + ' words, ' + mine.text.grams.size + ' three-word keys, ' + Math.round(performance.now() - t0) + ' ms');
  if (mine.rewrap) {
    // Quotes saved from the old text carry its line breaks: cut them again from the joined text.
    for (const m of book.marks) {
      if (m.status !== 'done') continue;
      if (!m.loc) {
        const before = tokenize(m.before).words, loc = findInBook(mine.text, before.concat(tokenize(m.after).words), before.length);
        if (loc) m.loc = [loc.start, loc.split, loc.end];
      }
      if (m.loc) requote(m, mine.text);
    }
    save(true); renderMarks();
  }
  if (!mine.meta.tablesDone) {
    // Books added before tables written as plain lines were recognised: look for them now.
    mine.meta.figures = mine.meta.figures.filter((x) => !x.plain).concat(findTextTables(mine.text.text)).sort((x, y) => x.at - y.at);
    mine.meta.tablesDone = true;
    for (const m of book.marks) delete m.figs;   // figure numbers have shifted
    store('write', id, 'meta', new Blob([JSON.stringify(mine.meta)], { type: 'application/json' })).catch(() => {});
  }
  if (!mine.meta.sized) {
    // Books added before rules, ornaments and cover thumbnails were recognised: drop those now.
    const keep = [];
    for (const fig of mine.meta.figures) {
      const pic = fig.kind === 'image' ? await stored(id, 'img-' + fig.img) : null;
      if (pic && (/^cover ?(image|art)?$/i.test(fig.cap || '') || isOrnament(new Uint8Array(await pic.slice(0, 1 << 20).arrayBuffer())))) continue;
      keep.push(fig);
    }
    if (cur !== mine) return;
    if (keep.length !== mine.meta.figures.length) {
      detail('dropped ' + (mine.meta.figures.length - keep.length) + ' ornaments from the figures');
      mine.meta.figures = keep;
      for (const m of book.marks) delete m.figs;   // figure numbers have shifted
    }
    mine.meta.sized = true;
    store('write', id, 'meta', new Blob([JSON.stringify(mine.meta)], { type: 'application/json' })).catch(() => {});
  }
  // Bookmarks made before page labels were cleaned up kept "page 62." as their page.
  for (const m of book.marks) if (m.page && m.page !== pageNumber(m.page)) m.page = pageNumber(m.page);
  renderFigTab(); renderSearchTab();
  rematch(); runQueue(); renderInfo();
}

// Loads the open book's page scan index, used to give quotes print page numbers.
export async function loadPageScan(mine) {
  const f = await stored(mine.book.id, 'pagesrc');
  if (!f || cur !== mine) return;
  try {
    const src = JSON.parse(await f.text());
    mine.pageSrc = { labels: src.labels, count: src.pages.length, index: buildPageIndex(src.pages) };
    findPages(); renderInfo();
  } catch (e) { /* unreadable page source: carry on without it */ }
}

// A book added without a cover takes one from text or a page scan added later.
async function coverIfNone(mine, get) {
  if (mine.book.hasCover) return;
  try {
    const blob = await get();
    if (!blob) return;
    await showCover(mine, blob);
  } catch (e) { /* no cover then */ }
}
async function showCover(mine, blob) {
  const u = await setCover(mine.book, blob);
  if (cur === mine && u) { mine.coverUrl = u; $('cover').src = u; }
}

// A cover picked by hand, in place of any other.
$('coverFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, had = mine.book.hasCover;
  log('cover picked: ' + f.name + ' (' + (f.type || 'no type') + ', ' + mb(f.size) + ')');
  try { const bmp = await createImageBitmap(f); detail('cover is ' + bmp.width + '×' + bmp.height); bmp.close(); } catch (err) {
    log('cover not usable: ' + ((err && err.message) || err)); toast('That picture can’t be shown here', 'warn'); return;
  }
  try { await showCover(mine, f); } catch (err) { log('cover not saved: ' + ((err && err.message) || err)); toast('Cover not saved', 'warn'); return; }
  log('cover ' + (had ? 'changed' : 'added') + (cur === mine && mine.coverUrl ? '' : ', but not shown'));
  if (cur === mine) renderInfo();
  toast(had ? 'Cover changed' : 'Cover added');
});

// Adding or replacing the text or page scan from About this book.
$('textFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book, done = busy('Adding text');
  try {
    toast('Reading the text…');
    const doc = await readBook(f);
    await storeText(b.id, doc);
    b.hasText = true; b.textName = f.name; b.pageCount = doc.pages.length;
    b.fromText = fromDoc(doc);
    // Saved positions pointed into the old text, so they can't be re-cut against the new one.
    for (const m of b.marks) { delete m.loc; delete m.figs; delete m.trim; }
    delete b.anchors; delete b.autoNaming;
    resolveMeta(b); save(true);
    await coverIfNone(mine, () => doc.cover);
    if (cur !== mine) return;
    mine.meta = { toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true, unwrapped: true, sized: true };
    renderFigTab();
    mine.text = buildBook(doc.text);
    renderSearchTab();
    metaChanged(); rematch(); runQueue();
    toast('Book text added');
  } catch (err) {
    if (cur === mine) { renderInfo(); toast('Could not read that file', 'warn'); }
  } finally { done(); }
});
$('pageFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book, say = (msg) => { if (cur === mine) $('textStatus').textContent = msg; }, done = busy('Adding pages');
  try {
    say('Reading ' + f.name + '…');
    const pdf = await readPdfPages(f, (p) => say('Reading ' + f.name + '… ' + Math.round(p * 100) + '%'));
    await store('write', b.id, 'pagesrc', new Blob([JSON.stringify(pdf)], { type: 'application/json' }));
    await store('write', b.id, 'pagepdf', f);
    b.hasPagePdf = true;
    b.pageSrcName = f.name;
    b.pageFirst = guessFirstNumbered(pdf.pages) || 1;
    save(true);
    await coverIfNone(mine, () => pdfCover(f));
    if (cur !== mine) return;
    mine.pageSrc = { labels: pdf.labels, count: pdf.pages.length, index: buildPageIndex(pdf.pages) };
    const quotes = b.marks.filter((m) => m.status === 'done').length, found = findPages();
    renderInfo();
    toast(quotes ? 'Pages found for ' + found + ' of ' + quotes + (quotes === 1 ? ' quote' : ' quotes') : 'Page scan added');
  } catch (err) {
    if (cur === mine) { renderInfo(); toast('Page scan not added: ' + ((err && err.message) || err), 'warn'); }
  } finally { done(); }
});

// ---------- The pieces of a book in About this book ----------
// Each tile is one piece. A missing one is added with a tap; one that is there
// offers Replace (the same file picker) and Remove.
async function removeText(mine) {
  const b = mine.book, id = b.id;
  await store('remove', id, 'text');
  await store('remove', id, 'meta');
  for (let i = 0; await stored(id, 'img-' + i); i++) await store('remove', id, 'img-' + i);
  b.hasText = false; b.textName = ''; b.pageCount = 0; b.fromText = fromDoc(null);
  if (b.links) delete b.links.text;
  // Places in the text and the figures found there go with it; the quotes themselves stay.
  for (const m of b.marks) { delete m.loc; delete m.figs; delete m.trim; }
  delete b.anchors; delete b.autoNaming;
  resolveMeta(b); save(true);
  if (cur !== mine) return;
  mine.text = null;
  mine.meta = { toc: [], pages: [], figures: [] };
  metaChanged(); renderFigTab(); renderSearchTab(); renderMarks();
}
async function removePageScan(mine) {
  const b = mine.book;
  await store('remove', b.id, 'pagesrc');
  await store('remove', b.id, 'pagepdf');
  b.hasPagePdf = false; b.pageSrcName = ''; delete b.pageFirst;
  if (b.links) delete b.links.pdf;
  // Page numbers that came from the scan go with it.
  for (const m of b.marks) if (m.pdfPage != null) { delete m.pdfPage; m.page = ''; }
  save(true);
  if (cur !== mine) return;
  mine.pageSrc = null;
  renderMarks(); renderInfo();
}
async function removeCover(mine) {
  await clearCover(mine.book);
  if (cur !== mine) return;
  mine.coverUrl = null;
  $('cover').removeAttribute('src');
  renderInfo();
}
const PIECES = {
  text: { name: 'book text', input: 'textFile', has: (b) => b.hasText, remove: removeText },
  page: { name: 'page scan', input: 'pageFile', has: (b) => !!b.pageSrcName, remove: removePageScan },
  extras: { name: 'extras', input: 'extrasFile', has: (b) => b.hasExtras, remove: removeExtras },
  cover: { name: 'cover', input: 'coverFile', has: (b) => b.hasCover, remove: removeCover },
  marks: { input: 'marksFile', has: () => false },
};
const REPLACE = 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4';
for (const [key, piece] of Object.entries(PIECES)) {
  const tile = $(key + 'Act');
  tile.addEventListener('click', () => {
    if (!cur) return;
    if (!piece.has(cur.book)) { $(piece.input).click(); return; }
    const mine = cur;
    showMenu(tile.getBoundingClientRect(), [
      { label: 'Replace', icon: REPLACE, run: () => $(piece.input).click() },
      { label: 'Remove', icon: TRASH, danger: true, run: async () => {
        try { await piece.remove(mine); log(piece.name + ' removed'); toast(piece.name[0].toUpperCase() + piece.name.slice(1) + ' removed'); }
        catch (err) { log(piece.name + ' not removed: ' + ((err && err.message) || err)); toast('Couldn’t remove the ' + piece.name, 'warn'); }
      } },
    ], { inside: $('infoDlg') });
  });
}
