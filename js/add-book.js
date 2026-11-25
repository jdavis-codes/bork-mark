// The Add a book sheet: copies the audio, and the book text and page scan if given, onto the device.

import { openAudio } from './audio/container.js';
import { storeText } from './book-files.js';
import { openBook } from './player.js';
import { readBook } from './sources/index.js';
import { guessFirstNumbered, readPdfPages } from './sources/pdf.js';
import { fromDoc, resolveMeta, save, state } from './state.js';
import { store } from './storage.js';
import { $, fmt, setFill, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';
import { detail, log, mb } from './log.js';

// The three files a book can have. Only the audio is required.
const PICKS = [
  { key: 'Audio', hint: 'M4B or MP3 · required' },
  { key: 'Text', hint: 'EPUB or TXT · for exact quotes' },
  { key: 'Pdf', hint: 'PDF of the print edition · page numbers' },
];
function renderPick({ key, hint }) {
  const f = $('add' + key).files[0];
  $('add' + key + 'Name').textContent = f ? f.name + ' · ' + (f.size < 1048576 ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : (f.size / 1048576).toFixed(0) + ' MB') : hint;
  $('pick' + key).classList.toggle('chosen', !!f);
}
// Progress while a book is being added: a message, and how far along (0 to 1).
function addSay(msg, frac) {
  $('addStatus').textContent = msg; $('addStatus').className = 'muted';
  $('addProgress').style.visibility = frac == null ? 'hidden' : 'visible';   // keeps its space, so the sheet doesn't jump
  if (frac != null) setFill($('addFill'), frac);
}
function addBusy(on) {
  $('addGo').disabled = on || !$('addAudio').files[0];
  $('addCancel').disabled = on;
  for (const { key } of PICKS) $('add' + key).disabled = on;
  $('addDlg').classList.toggle('busy', on);
}
$('addBtn').addEventListener('click', () => {
  for (const pick of PICKS) { $('add' + pick.key).value = ''; renderPick(pick); }
  addSay(''); addBusy(false);
  $('addDlg').showModal();
});
$('addCancel').addEventListener('click', () => closeSheet($('addDlg')));
for (const pick of PICKS) $('add' + pick.key).addEventListener('change', () => { renderPick(pick); addBusy(false); });
$('addGo').addEventListener('click', async () => {
  const af = $('addAudio').files[0], tf = $('addText').files[0], pf = $('addPdf').files[0];
  if (!af || $('addDlg').classList.contains('busy')) return;
  addBusy(true);
  const id = crypto.randomUUID();
  try {
    let t0 = performance.now();
    const took = () => { const ms = Math.round(performance.now() - t0); t0 = performance.now(); return ms + ' ms'; };
    log('adding a book: ' + af.name + ' (' + mb(af.size) + ')' + (tf ? ' + ' + tf.name + ' (' + mb(tf.size) + ')' : '') + (pf ? ' + ' + pf.name + ' (' + mb(pf.size) + ')' : ''));
    addSay('Reading the audiobook…', 0);
    const src = await openAudio(af, (p) => addSay('Reading the audiobook…', p * 0.1));
    detail('audio read: ' + src.kind + ', ' + fmt(src.duration) + ', ' + src.chapters.length + ' chapters, cover ' + (src.tags.cover ? mb(src.tags.cover.size) : 'none') + ', ' + took());
    let doc = null;
    if (tf) {
      addSay('Reading the book text…', 0.1); doc = await readBook(tf);
      detail('text read: ' + doc.text.length + ' characters, ' + doc.toc.length + ' contents entries, ' + doc.pages.length + ' pages, '
        + doc.figures.length + ' figures, ' + doc.images.length + ' pictures (' + mb(doc.images.reduce((n, x) => n + x.size, 0)) + '), ' + took());
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await store('write', id, 'audio', af, (p) => addSay('Copying the audiobook… ' + Math.round(p * 100) + '%', 0.15 + p * 0.7));
    if (src.tags.cover) await store('write', id, 'cover', src.tags.cover);
    detail('audio copied: ' + took());
    if (doc) { await storeText(id, doc); detail('text stored: ' + took()); }
    // A page scan that can't be used shouldn't stop the book being added.
    let pdf = null, pdfProblem = '';
    if (pf) {
      try {
        pdf = await readPdfPages(pf, (p) => addSay('Reading the page scan… ' + Math.round(p * 100) + '%', 0.85 + p * 0.15));
        await store('write', id, 'pagesrc', new Blob([JSON.stringify(pdf)], { type: 'application/json' }));
        await store('write', id, 'pagepdf', pf);
        detail('page scan read: ' + pdf.pages.length + ' pages, ' + took());
      } catch (err) { pdf = null; pdfProblem = (err && err.message) || String(err); }
    }
    const book = {
      id, fromAudio: { title: src.tags.title || '', author: src.tags.author || '' },
      fromText: fromDoc(doc),
      audioName: af.name, kind: src.kind, duration: src.duration, chapters: src.chapters,
      hasCover: !!src.tags.cover, hasText: !!doc, textName: tf ? tf.name : '', pageCount: doc ? doc.pages.length : 0,
      position: 0, speed: 1, added: Date.now(), marks: [],
    };
    if (pdf) { book.hasPagePdf = true; book.pageSrcName = pf.name; book.pageFirst = guessFirstNumbered(pdf.pages) || 1; }
    resolveMeta(book);
    state.books.unshift(book);
    save(true);
    addBusy(false);
    closeSheet($('addDlg'));
    // The speech model is not loaded here: it loads once the book's text is
    // ready and something needs it, so the two heavy steps don't overlap.
    await openBook(id);
    if (pdfProblem) toast('Book added, but not the page scan: ' + pdfProblem);
  } catch (err) {
    log('adding failed: ' + ((err && err.message) || err));
    await store('remove', id).catch(() => {});
    addBusy(false);
    addSay('Could not add this book: ' + ((err && err.message) || err));
    $('addStatus').className = 'warn';
  }
});
