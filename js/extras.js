// Extras: the PDF of figures, notes or worksheets that comes with an audiobook. Storing it, the
// Extras sheet (what was found in it, chapter by chapter, or every page) and looking at a page.

import { renderInfo } from './info.js';
import { crumb, detail, log } from './log.js';
import { chapterAt, cur } from './player.js';
import { chapterNumber, readExtras } from './sources/extras.js';
import { browsePdf } from './sources/pdf.js';
import { save } from './state.js';
import { store, stored } from './storage.js';
import { $, audio, el, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';
import { showViewer } from './viewer.js';

// Reads an extras PDF and keeps it, with the list of what was found in it.
export async function storeExtras(book, file, onProgress) {
  crumb('reading the extras');
  try {
    const info = await readExtras(file, onProgress);
    await store('write', book.id, 'extras', new Blob([JSON.stringify(info)], { type: 'application/json' }));
    await store('write', book.id, 'extraspdf', file);
    book.hasExtras = true; book.extrasName = file.name; book.extrasPages = info.count;
    detail('extras read: ' + info.count + ' pages, ' + info.entries.length + ' entries, chapters '
      + [...new Set(info.entries.map((e) => e.ch).filter((c) => c != null))].join(','));
    return info;
  } finally { crumb(null); }
}
// Loads the open book's extras list once the player is up.
export async function loadExtras(mine) {
  const f = await stored(mine.book.id, 'extras');
  if (!f || cur !== mine) return;
  try { mine.extras = JSON.parse(await f.text()); } catch (e) { return; }
  renderExtrasTab();
}
export function renderExtrasTab() {
  const n = cur && cur.book.hasExtras ? cur.book.extrasPages || 0 : 0;
  $('extrasBtn').hidden = !n;
  $('extrasLabel').textContent = n ? String(n) : '';
  $('extrasBtn').setAttribute('aria-label', 'Extras, ' + n + ' pages');
}

// The chapter being listened to, when the audio's chapters are numbered.
function chapterNow() {
  const c = chapterAt(cur.book, audio.currentTime || cur.book.position || 0);
  return c.count > 1 ? chapterNumber(c.title) : null;
}
// Entries in the order of the PDF, gathered under the chapter they belong to.
function groups(entries) {
  const out = [];
  for (const e of entries) {
    let g = out[out.length - 1];
    if (!g || g.ch !== e.ch) { g = { ch: e.ch, head: null, rows: [], page: e.page }; out.push(g); }
    if (e.kind === 'chapter' && !g.head && !g.rows.length) g.head = e; else g.rows.push(e);
  }
  return out;
}

// While the sheet is open the PDF stays open, so pages draw quickly.
let pdf = null, opening = null, thumbs = null, urls = [], view = 'contents', showing = 0;
function openPdfOnce() {
  if (pdf) return Promise.resolve(pdf);
  if (!opening) {
    const mine = cur;
    opening = stored(mine.book.id, 'extraspdf').then(async (f) => {
      if (!f) throw new Error('the extras PDF is not stored on this device');
      const doc = await browsePdf(f);
      if (cur !== mine || !$('extrasDlg').open) { doc.close(); throw new Error('closed'); }
      pdf = doc;
      return doc;
    }).finally(() => { opening = null; });
  }
  return opening;
}
function closePdf() {
  if (pdf) pdf.close();
  pdf = null;
  if (thumbs) thumbs.disconnect();
  thumbs = null;
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  $('extrasGrid').textContent = ''; $('extrasList').textContent = '';
}

function renderContents() {
  const box = $('extrasList'), now = chapterNow(), list = groups(cur.extras.entries);
  box.textContent = '';
  let current = null;
  list.forEach((g, k) => {
    const section = el('section', 'exgroup'), head = el('button', 'exhead');
    const name = g.ch != null ? 'Chapter ' + g.ch : k === 0 ? 'Before the chapters' : 'After the chapters';
    head.append(el('span', '', name + (g.head && g.head.title ? ' · ' + g.head.title : '')));
    if (g.ch != null && g.ch === now) { head.append(el('span', 'exnow', 'Listening')); section.classList.add('now'); current = current || section; }
    head.addEventListener('click', () => showPage(g.page));
    section.append(head);
    for (const e of g.rows) {
      const row = el('button', 'exrow'), text = el('span', 'figtext');
      text.append(el('span', 'figcap', e.label), el('span', 'muted', e.title));
      row.append(text, el('span', 'expage', 'p. ' + e.page));
      row.addEventListener('click', () => showPage(e.page, e.label));
      section.append(row);
    }
    box.append(section);
  });
  return current;
}
// Small pictures of every page, drawn as they scroll into view, one at a time.
function renderGrid() {
  const grid = $('extrasGrid'), n = cur.extras.count;
  if (grid.childElementCount === n) return;
  grid.textContent = '';
  const queue = [];
  let busy = false;
  const next = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const cell = queue.shift();
      try {
        const doc = await openPdfOnce(), canvas = await doc.draw(Number(cell.dataset.page), 300);
        const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.7));
        canvas.width = canvas.height = 0;   // hand the canvas's memory back at once
        if (!pdf || !blob) break;
        const img = el('img'); img.alt = '';
        const url = URL.createObjectURL(blob); urls.push(url); img.src = url;
        cell.firstElementChild.replaceChildren(img);
      } catch (e) { break; }
    }
    busy = false;
  };
  thumbs = new IntersectionObserver((seen) => {
    for (const s of seen) if (s.isIntersecting) { thumbs.unobserve(s.target); queue.push(s.target); }
    next();
  }, { root: $('extrasDlg'), rootMargin: '300px' });
  for (let p = 1; p <= n; p++) {
    const cell = el('button', 'excell'), frame = el('span', 'exthumb');
    frame.style.aspectRatio = '1 / ' + (cur.extras.ratio || 1.4);
    cell.dataset.page = p; cell.setAttribute('aria-label', 'Page ' + p);
    cell.append(frame, el('span', 'muted', String(p)));
    cell.addEventListener('click', () => showPage(p));
    grid.append(cell); thumbs.observe(cell);
  }
}
function setView(which) {
  view = which;
  const has = cur.extras.entries.length > 0;
  if (!has) view = 'pages';
  $('extrasView').hidden = !has;
  $('exContents').setAttribute('aria-pressed', String(view === 'contents'));
  $('exPages').setAttribute('aria-pressed', String(view === 'pages'));
  $('extrasList').hidden = view !== 'contents'; $('extrasGrid').hidden = view !== 'pages';
  if (view === 'pages') renderGrid();
}

// One page, large, with the entries on it named and buttons to the pages either side.
async function showPage(n, label) {
  const mine = cur, total = mine.extras.count;
  n = Math.max(1, Math.min(total, n));
  showing = n;
  const here = mine.extras.entries.filter((e) => e.page === n && e.kind !== 'chapter').map((e) => e.label);
  const prev = el('button', 'small', '‹ Previous'), next = el('button', 'small', 'Next ›'), where = el('span', 'muted', 'Page ' + n + ' of ' + total);
  prev.disabled = n === 1; next.disabled = n === total;
  prev.addEventListener('click', () => showPage(n - 1));
  next.addEventListener('click', () => showPage(n + 1));
  showViewer(label || here.join(', ') || 'Extras', el('p', 'muted', 'Drawing the page…'), null, [prev, where, next]);
  $('viewTools').classList.add('pager');
  try {
    const doc = await openPdfOnce();
    const canvas = await doc.draw(n, 1500);
    if (showing !== n || cur !== mine || !$('viewDlg').open) return;
    canvas.className = 'figimg';
    // Tap to enlarge a page too small to read, and again to fit it back.
    const frame = el('div', 'pagezoom');
    frame.append(canvas);
    frame.addEventListener('click', () => {
      const big = frame.classList.toggle('big');
      if (big) frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
    });
    $('viewBody').replaceChildren(frame);
  } catch (err) {
    if (showing === n && $('viewDlg').open) $('viewBody').replaceChildren(el('p', 'warn', 'Could not draw that page: ' + ((err && err.message) || err)));
  }
}

$('extrasBtn').addEventListener('click', () => {
  if (!cur || !cur.extras) return;
  $('extrasCount').textContent = '(' + cur.extras.count + (cur.extras.count === 1 ? ' page)' : ' pages)');
  const current = renderContents();
  setView(current || view === 'contents' ? 'contents' : view);
  $('extrasDlg').showModal();
  $('extrasDlg').scrollTop = 0;
  // Start at the chapter being listened to.
  if (current && view === 'contents') current.scrollIntoView({ block: 'start' });
  openPdfOnce().catch(() => {});
});
$('exContents').addEventListener('click', () => { setView('contents'); $('extrasDlg').scrollTop = 0; });
$('exPages').addEventListener('click', () => { setView('pages'); $('extrasDlg').scrollTop = 0; });
$('extrasClose').addEventListener('click', () => closeSheet($('extrasDlg')));
$('extrasDlg').addEventListener('close', closePdf);
$('viewDlg').addEventListener('close', () => { showing = 0; $('viewTools').classList.remove('pager'); });

// Adding or replacing the extras from About this book.
$('extrasFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  const mine = cur, say = (msg) => { if (cur === mine) $('textStatus').textContent = msg; };
  try {
    say('Reading ' + f.name + '…');
    const info = await storeExtras(mine.book, f, (p) => say('Reading ' + f.name + '… ' + Math.round(p * 100) + '%'));
    save(true);
    if (cur !== mine) return;
    mine.extras = info;
    renderExtrasTab(); renderInfo();
    toast(info.entries.length ? 'Extras added: ' + info.entries.length + ' things found in ' + info.count + ' pages' : 'Extras added: ' + info.count + ' pages');
  } catch (err) {
    log('extras failed: ' + ((err && err.message) || err));
    if (cur === mine) { renderInfo(); toast('Could not use that PDF: ' + ((err && err.message) || err)); }
  }
});
