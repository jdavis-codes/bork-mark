// From a located bookmark to its quote, print page and figures; and citations for sharing.

import { formatCitation } from './cite.js';
import { renderMarks } from './marks.js';
import { chapterAt, cur } from './player.js';
import { pageOf } from './sources/pdf.js';
import { save, settings } from './state.js';
import { entryAt, findInBook, pageNumber } from './text/book.js';
import { quoteAt } from './text/quote.js';
import { fmt } from './ui/dom.js';

export function applyQuote(m, text) {
  const loc = findInBook(text, m.words, m.split);
  if (!loc) { m.status = 'nomatch'; return; }
  applyPlace(m, loc, text);
}
// The quote for a bookmark whose place in the book is known.
export function applyPlace(m, loc, text) {
  // The place in the book is kept, so the quote can be re-cut if the capture setting changes.
  m.status = 'done'; m.loc = [loc.start, loc.split, loc.end]; m.confidence = loc.confidence;
  requote(m, text);
  delete m.words; delete m.split; delete m.transcript;
}
export function requote(m, text) {
  const point = text.starts.length ? text.starts[Math.min(m.loc[1], text.starts.length - 1)] : 0;
  if (m.trim && m.trim[0] <= point && m.trim[1] >= point) {   // trimmed by hand: exactly those characters
    m.before = text.text.slice(m.trim[0], point); m.after = text.text.slice(point, m.trim[1]);
  } else {
    const q = quoteAt(text, { start: m.loc[0], split: m.loc[1], end: m.loc[2] }, settings.capture);
    m.before = q.before; m.after = q.after;
  }
  if (cur && cur.text === text && text.starts.length) {
    // Where in the book this is, for citing: its contents entry and print page.
    const section = entryAt(cur.meta.toc, point), page = entryAt(cur.meta.pages, point);
    m.section = section ? section.label : ''; m.page = page ? pageNumber(page.label) : '';
    // Pictures and tables that fall inside the quote.
    const from = point - m.before.length - 40, to = point + m.after.length + 40;
    m.figs = cur.meta.figures.map((f, i) => (f.at >= from && f.at <= to ? i : -1)).filter((i) => i >= 0).slice(0, 6);
  }
  if (cur && cur.pageSrc) {   // a scanned edition, when added, decides the page
    m.pdfPage = pageOf(cur.pageSrc.index, m.before, m.after);
    if (m.pdfPage != null) m.page = pageLabel(cur.book, cur.pageSrc, m.pdfPage);
  }
}
// ---------- page numbers from a scanned PDF ----------
// The printed page number for a PDF page (counted from 0): the PDF's own
// label if it has them, otherwise counted from the page set as "page 1".
export function pageLabel(b, src, i) {
  if (src.labels) return src.labels[i] || '';
  const n = i + 1 - ((b.pageFirst || 1) - 1);
  return n >= 1 ? String(n) : '';
}
// Looks up quotes in the scan. Quotes it can't place keep whatever page they had.
export function findPages(onlyMissing) {
  if (!cur || !cur.pageSrc) return 0;
  let found = 0;
  for (const m of cur.book.marks) {
    if (m.status !== 'done') continue;
    if (!(onlyMissing && m.pdfPage != null)) m.pdfPage = pageOf(cur.pageSrc.index, m.before, m.after);
    if (m.pdfPage != null) { m.page = pageLabel(cur.book, cur.pageSrc, m.pdfPage); found++; }
  }
  save(true); renderMarks();
  return found;
}

// The line under a shared quote, in the style chosen in Settings.
const citeOptions = () => ({ style: settings.citeStyle, audioTime: settings.citeTime, audioText: settings.citeTimeText });
function citation(b, m) {
  const c = chapterAt(b, m.t), section = m.section || (c.count > 1 ? c.title : '');
  return formatCitation({ author: b.author, title: b.title, publisher: b.publisher, year: b.year, section, page: m.page, time: fmt(m.t) }, citeOptions());
}
export const shareText = (b, m) => (m.status === 'done' ? '“' + (m.before + m.after).trim() + '”' : m.transcript) + '\n\n— ' + citation(b, m);
export function requoteAll() {
  if (!cur || !cur.text) return;
  for (const m of cur.book.marks) if (m.status === 'done' && m.loc) requote(m, cur.text);
  save(true); renderMarks();
}

// Bookmarks transcribed before the book text was available can be matched
// now without listening to the audio again.
export function rematch() {
  if (!cur || !cur.text) return;
  let changed = false;
  for (const m of cur.book.marks) {
    if ((m.status === 'transcribed' || m.status === 'nomatch') && m.words) { applyQuote(m, cur.text); changed = true; }
  }
  if (changed) { save(true); renderMarks(); }
}
