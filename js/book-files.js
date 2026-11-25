// The open book's text and page scan: storing and loading them, and adding or replacing them
// from About this book.

import { renderFigTab } from './figures.js';
import { metaChanged, renderInfo } from './info.js';
import { renderMarks } from './marks.js';
import { cur } from './player.js';
import { runQueue } from './queue.js';
import { findPages, rematch, requote } from './quotes.js';
import { readBook } from './sources/index.js';
import { buildPageIndex, guessFirstNumbered, readPdfPages } from './sources/pdf.js';
import { fromDoc, resolveMeta, save } from './state.js';
import { store, stored } from './storage.js';
import { buildBook, findInBook, tokenize } from './text/book.js';
import { findTextTables, unwrapLines } from './text/cleanup.js';
import { $, toast } from './ui/dom.js';

// The book text, plus where its contents entries and print pages fall in it.
export async function storeText(id, doc) {
  await store('write', id, 'text', new Blob([doc.text], { type: 'text/plain' }));
  await store('write', id, 'meta', new Blob([JSON.stringify({ toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true, unwrapped: true })], { type: 'application/json' }));
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
  mine.text = buildBook(bookText);
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
  renderFigTab();
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

// Adding or replacing the text or page scan from About this book.
$('textFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book;
  try {
    toast('Reading ' + f.name + '…');
    const doc = await readBook(f);
    await storeText(b.id, doc);
    b.hasText = true; b.textName = f.name; b.pageCount = doc.pages.length;
    b.fromText = fromDoc(doc);
    // Saved positions pointed into the old text, so they can't be re-cut against the new one.
    for (const m of b.marks) { delete m.loc; delete m.figs; delete m.trim; }
    delete b.anchors; delete b.autoNaming;
    resolveMeta(b); save(true);
    if (cur !== mine) return;
    mine.meta = { toc: doc.toc, pages: doc.pages, figures: doc.figures, tablesDone: true, unwrapped: true };
    renderFigTab();
    mine.text = buildBook(doc.text);
    metaChanged(); rematch(); runQueue();
    toast('Book text added');
  } catch (err) {
    if (cur === mine) { renderInfo(); toast('Could not read that file'); }
  }
});
$('pageFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, b = mine.book, say = (msg) => { if (cur === mine) $('textStatus').textContent = msg; };
  try {
    say('Reading ' + f.name + '…');
    const pdf = await readPdfPages(f, (p) => say('Reading ' + f.name + '… ' + Math.round(p * 100) + '%'));
    await store('write', b.id, 'pagesrc', new Blob([JSON.stringify(pdf)], { type: 'application/json' }));
    await store('write', b.id, 'pagepdf', f);
    b.hasPagePdf = true;
    b.pageSrcName = f.name;
    b.pageFirst = guessFirstNumbered(pdf.pages) || 1;
    save(true);
    if (cur !== mine) return;
    mine.pageSrc = { labels: pdf.labels, count: pdf.pages.length, index: buildPageIndex(pdf.pages) };
    const quotes = b.marks.filter((m) => m.status === 'done').length, found = findPages();
    renderInfo();
    toast(quotes ? 'Pages found for ' + found + ' of ' + quotes + (quotes === 1 ? ' quote' : ' quotes') : 'Page PDF added');
  } catch (err) {
    if (cur === mine) { renderInfo(); toast('Could not use that PDF: ' + ((err && err.message) || err)); }
  }
});
