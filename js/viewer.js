// Showing a picture, table or scanned page.

import { jumpToFigure } from './figures.js';
import { cur } from './player.js';
import { pageLabel } from './quotes.js';
import { pageOf, renderPdfPage } from './sources/pdf.js';
import { stored } from './storage.js';
import { $, el, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';

let viewUrl = null;
function showViewer(title, node, figure) {
  if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = null; }
  $('viewTitle').textContent = title;
  $('viewBody').replaceChildren(node);
  // For a figure from the book text: jump the audio to it, or see it on the scanned page.
  const tools = $('viewTools');
  tools.textContent = '';
  if (figure != null) {
    const go = el('button', 'small', 'Go to this in the audio');
    go.addEventListener('click', () => jumpToFigure(figure));
    tools.append(go);
    if (cur.pageSrc && cur.book.hasPagePdf) {
      const scan = el('button', 'small', 'Scanned page');
      scan.addEventListener('click', () => {
        const f = cur.meta.figures[figure], t = cur.text.text;
        const i = pageOf(cur.pageSrc.index, t.slice(Math.max(0, f.at - 500), f.at), t.slice(f.at, f.at + 400));
        if (i == null) toast('Could not find this in the page scan'); else showPdfPage(i);
      });
      tools.append(scan);
    }
  }
  $('viewStatus').textContent = '';
  if (!$('viewDlg').open) $('viewDlg').showModal();
  $('viewDlg').scrollTop = 0;
}
export const figureName = (f, i) => f.cap || (f.kind === 'table' ? 'Table' : 'Picture') + ' ' + (i + 1);
export async function openFigure(i) {
  if (!cur) return;
  const f = cur.meta.figures[i];
  if (!f) return;
  if (f.kind === 'table') {
    const table = el('table', 'figtable');
    f.rows.forEach((cells, r) => {
      const tr = el('tr');
      for (const c of cells) {
        const cell = el(r === 0 ? 'th' : 'td', '', c);
        if (cells.length === 1) cell.colSpan = 12;   // a note that runs across the table
        tr.append(cell);
      }
      table.append(tr);
    });
    const wrap = el('div', 'figscroll'); wrap.append(table);
    showViewer(f.plain ? 'Table' : figureName(f, i), wrap, i);
    return;
  }
  const file = await stored(cur.book.id, 'img-' + f.img);
  if (!file) { toast('That picture is not stored on this device'); return; }
  const img = el('img', 'figimg');
  img.alt = f.cap || '';
  showViewer(figureName(f, i), img, i);
  viewUrl = URL.createObjectURL(file);
  img.src = viewUrl;
}
// Shows one page of the scan (counting from 0).
export async function showPdfPage(index) {
  const mine = cur, file = await stored(mine.book.id, 'pagepdf');
  if (!file) { toast('The page scan is not stored on this device'); return; }
  const label = pageLabel(mine.book, mine.pageSrc, index);
  showViewer((label ? 'Page ' + label : 'Scanned page') + ' · ' + mine.book.pageSrcName, el('p', 'muted', 'Drawing the page…'));
  try {
    const canvas = await renderPdfPage(file, index + 1);
    canvas.className = 'figimg';
    if (cur === mine && $('viewDlg').open) $('viewBody').replaceChildren(canvas);
  } catch (err) {
    if ($('viewDlg').open) $('viewBody').replaceChildren(el('p', 'warn', 'Could not draw that page: ' + ((err && err.message) || err)));
  }
}
$('viewClose').addEventListener('click', () => closeSheet($('viewDlg')));
