// PDFs of the print edition. Today a scan gives quotes their printed page numbers; reading a
// book's text from a PDF would be a reader in sources/index.js.

import { buildBook, locate, tokenize } from '../text/book.js';

// A clean EPUB gives good quotes but usually no page numbers; a scan of the
// print edition has the pages but rough, machine-read text. Used together,
// the quote keeps the EPUB's wording and the scan says which page it is on.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';

// Text of every page of a PDF, plus the PDF's own page labels if it has any.
export async function openPdf(file) {
  const pdfjs = await import(PDFJS + 'pdf.min.mjs');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // A worker script must come from this site, so fetch the library's and wrap it.
    const code = await (await fetch(PDFJS + 'pdf.worker.min.mjs')).text();
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  return await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

// One page of a PDF (counting from 1) drawn onto a canvas `width` pixels wide.
export async function renderPdfPage(file, number, width = 1400) {
  const doc = await openPdf(file);
  try {
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  } finally {
    doc.destroy();
  }
}

// A PDF kept open for looking through page after page, which is much quicker
// than opening it again for each one. Call close() when done with it.
export async function browsePdf(file) {
  const doc = await openPdf(file);
  return {
    count: doc.numPages,
    async draw(number, width) {
      const page = await doc.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup();
      return canvas;
    },
    close() { doc.destroy(); },
  };
}

export async function readPdfPages(file, onProgress = () => {}) {
  const doc = await openPdf(file);
  try {
    let labels = null;
    try { labels = await doc.getPageLabels(); } catch (e) { /* optional */ }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : ' ');
      // Rejoin words split across lines ("manu-" / "facturing").
      pages.push(text.replace(/[ \t]+/g, ' ').replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2').trim());
      page.cleanup();
      onProgress(i / doc.numPages);
    }
    if (pages.join('').length < pages.length * 20) throw new Error('this PDF has no text layer (it is images only)');
    // Labels that just count 1, 2, 3… add nothing over the page's position.
    if (labels && labels.every((l, i) => l === String(i + 1))) labels = null;
    return { pages, labels };
  } finally {
    doc.destroy();
  }
}

// Which PDF page (counting from 1) carries printed page number 1, worked out
// from the page numbers printed at the top or bottom of the scanned pages.
export function guessFirstNumbered(pages) {
  const votes = new Map();
  pages.forEach((text, i) => {
    const words = text.split(/\s+/);
    for (const w of new Set([words[0], words[words.length - 1]])) {
      if (!/^\d{1,4}$/.test(w || '')) continue;
      const n = Number(w);
      if (n < 1 || n > pages.length) continue;
      const first = i + 1 - (n - 1);
      votes.set(first, (votes.get(first) || 0) + 1);
    }
  });
  let best = null, count = 0;
  for (const [first, c] of votes) if (c > count) { best = first; count = c; }
  return count >= Math.max(5, pages.length * 0.08) ? best : null;
}

export function buildPageIndex(pages) {
  const starts = [];
  let text = '';
  for (const p of pages) { starts.push(text.length); text += p + '\n\n'; }
  return { book: buildBook(text), starts };
}

// The PDF page (counting from 0) on which the bookmarked point of a quote
// falls, or null when the passage can't be found in the scan.
export function pageOf(index, before, after) {
  const b = tokenize(before).words.slice(-70), a = tokenize(after).words.slice(0, 50);
  const words = b.concat(a);
  if (words.length < 8 || !index.book.starts.length) return null;
  const loc = locate(index.book, words, b.length);
  if (!loc || !loc.found) return null;
  const at = index.book.starts[Math.min(loc.split, index.book.starts.length - 1)];
  let i = 0;
  while (i + 1 < index.starts.length && index.starts[i + 1] <= at) i++;
  return i;
}
