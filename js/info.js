// The About this book sheet: editable details, the chapter list, file links, removing the book.

import { chaptersChanged, keepAudioChapters, nameChapters, namingChapters } from './chapter-names.js';
import { chapterOutline, closeBook, cur, setMediaSession } from './player.js';
import { findPages } from './quotes.js';
import { showLibrary } from './screens.js';
import { META, resolveMeta, save, state } from './state.js';
import { store } from './storage.js';
import { $, el, fmt, icon, toast } from './ui/dom.js';
import { setScroll } from './ui/marquee.js';
import { closeSheet } from './ui/sheets.js';

const PENCIL = 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4';
// A value with a pencil beside it. Tapping the pencil turns the text into a
// plain underlined field; Return or tapping away saves, Escape cancels.
function editable(value, label, onSave, shown) {
  const wrap = el('span', 'editable'), text = shown instanceof Node ? shown : el('span', '', shown || value || '—');
  const btn = el('button', 'pencil');
  btn.type = 'button'; btn.setAttribute('aria-label', 'Edit ' + label); btn.append(icon(PENCIL));
  btn.addEventListener('click', () => {
    const input = el('input', 'inline');
    input.type = 'text'; input.value = value; input.setAttribute('aria-label', label);
    input.autocomplete = 'off'; input.enterKeyHint = 'done';
    let done = false;
    const finish = (keep) => { if (done) return; done = true; if (keep) onSave(input.value.trim()); else renderInfo(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    wrap.replaceChildren(input);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
  wrap.append(text, btn);
  return wrap;
}

let chaptersOpen = false, chapStatusText = '';
// The line under the chapter list that says how naming chapters is going.
export function setChapStatus(msg) {
  chapStatusText = msg;
  const p = $('chapStatus');
  if (p) p.textContent = msg;
}
// The files whose names are shown in full, until the sheet is opened for another book.
const openNames = new Set();
export function renderInfo() {
  if (!cur) return;
  const b = cur.book, dl = $('infoList');
  dl.textContent = '';
  const row = (label, value) => {
    const dd = el('dd');
    dd.append(typeof value === 'string' ? document.createTextNode(value) : value);
    dl.append(el('dt', '', label), dd);
    return dd;
  };

  for (const f of META) {
    // Saving an empty field goes back to the value from the book text or audio file.
    row(f[0].toUpperCase() + f.slice(1), editable(b[f], f, (typed) => {
      const auto = b.fromText[f] || b.fromAudio[f] || '';
      if (!typed || typed === auto) delete b.edited[f]; else b.edited[f] = typed;
      metaChanged();
    }));
  }
  row('Length', fmt(b.duration));

  const ch = b.chapters || [], n = ch.length;
  if (n < 2) {
    row('Chapters', 'none in this audio file');
  } else {
    const toggle = el('button', 'disclose', String(n));
    toggle.setAttribute('aria-expanded', String(chaptersOpen));
    toggle.setAttribute('aria-label', n + ' chapters, ' + (chaptersOpen ? 'hide' : 'show') + ' list');
    toggle.append(icon('M6 9l6 6 6-6'));
    toggle.addEventListener('click', () => { chaptersOpen = !chaptersOpen; renderInfo(); });
    row('Chapters', toggle);
    if (chaptersOpen) {
      const box = el('div', 'chapbox'), ol = el('ol'), places = chapterOutline(b);
      ol.classList.toggle('nested', places.some((o) => o.depth > 0));
      ch.forEach((c, k) => {
        if (places[k].missing) ol.append(el('li', 'parthead', places[k].parent));
        const li = el('li', places[k].depth ? 'sub' : '');
        li.append(el('span', 'muted', fmt(c.start)), editable(c.title, 'name of chapter ' + (k + 1), (typed) => {
          if (typed && typed !== c.title) { keepAudioChapters(b); c.title = typed; c.src = 'you'; }
          chaptersChanged();
        }));
        ol.append(li);
      });
      const tools = el('div', 'row');
      if (cur.text && cur.meta.toc.length) {
        const auto = el('button', 'small', 'Name from book text');
        auto.disabled = namingChapters();
        auto.addEventListener('click', nameChapters);
        tools.append(auto);
      }
      if (b.audioChapters) {
        const reset = el('button', 'small', 'Reset names');
        reset.addEventListener('click', () => {
          if (!confirm('Put back the chapter names from the audio file?')) return;
          b.chapters = b.audioChapters; delete b.audioChapters;
          chaptersChanged();
        });
        tools.append(reset);
      }
      const status = el('p', 'subnote', chapStatusText);
      status.id = 'chapStatus';
      box.append(ol, tools, status);
      dl.append(box);
    }
  }

  // Each file can carry a web address: where it was bought or can be read.
  b.links = b.links || {};
  const fileRow = (label, name, key) => {
    const url = b.links[key], box = el('div', 'filerow');
    let shown = el('span', 'muted', 'Add a link');
    if (url) {
      shown = el('a', '', url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
      shown.href = url; shown.target = '_blank'; shown.rel = 'noopener';
    }
    // A long file name is cut to one line; tapping it shows the whole of it, and again cuts it.
    const file = el('button', 'filename' + (openNames.has(key) ? ' open' : ''), name);
    file.setAttribute('aria-expanded', String(openNames.has(key)));
    file.addEventListener('click', () => { if (!openNames.delete(key)) openNames.add(key); const open = file.classList.toggle('open'); file.setAttribute('aria-expanded', String(open)); });
    box.append(file, editable(url || '', 'link for the ' + label.toLowerCase(), (typed) => {
      // Only web addresses; a bare "libro.fm/…" gets https:// in front.
      const link = typed && !/^https?:\/\//i.test(typed) ? 'https://' + typed : typed;
      let ok = false;
      try { ok = !!link && /^https?:$/.test(new URL(link).protocol) && !/\s/.test(link); } catch (e) { /* not an address */ }
      if (ok) b.links[key] = link; else { delete b.links[key]; if (typed) toast('That doesn’t look like a web address'); }
      save(true); renderInfo();
    }, shown));
    row(label, box);
  };
  fileRow('Audio file', b.audioName + ' (' + b.kind + ')', 'audio');
  if (b.hasText) fileRow('Book text', b.textName || 'added', 'text');
  if (b.pageSrcName) {
    fileRow('Page PDF', b.pageSrcName + (cur.pageSrc ? ' (' + cur.pageSrc.count + ' pages)' : ''), 'pdf');
    // Scans start with unnumbered front matter; this says where page 1 is.
    if (cur.pageSrc && !cur.pageSrc.labels) {
      row('Page 1 is', editable(String(b.pageFirst || 1), 'which PDF page is printed page 1', (typed) => {
        const n = parseInt(typed.replace(/\D+/g, ''), 10);
        if (n >= 1 && n <= cur.pageSrc.count) { b.pageFirst = n; findPages(true); }
        renderInfo();
      }, 'PDF page ' + (b.pageFirst || 1)));
    }
  }
  if (b.hasExtras) fileRow('Extras', b.extrasName + ' (' + b.extrasPages + ' pages)', 'extras');
  row('Added', new Date(b.added).toLocaleDateString());
  $('pageBtnLabel').textContent = b.pageSrcName ? 'Replace page PDF' : 'Add page PDF';
  $('extrasBtnLabel').textContent = b.hasExtras ? 'Replace extras' : 'Add extras';
  $('textStatus').textContent = b.hasText
    ? 'Bookmarks quote the book’s own wording.'
    : 'No book text yet. Bookmarks show what the app heard; add the EPUB for exact quotes.';
  $('textBtnLabel').textContent = b.hasText ? 'Replace book text' : 'Add book text';
}
// Title and author changed: update everywhere they show.
export function metaChanged() {
  const b = cur.book;
  resolveMeta(b); save(true);
  setScroll($('title'), b.title); $('author').textContent = b.author;
  setMediaSession(); renderInfo();
}
$('infoBtn').addEventListener('click', () => { chaptersOpen = false; chapStatusText = ''; openNames.clear(); renderInfo(); $('infoDlg').showModal(); $('infoDlg').scrollTop = 0; });
$('infoClose').addEventListener('click', () => closeSheet($('infoDlg')));
$('removeBtn').addEventListener('click', async () => {
  if (!cur) return;
  const b = cur.book, n = b.marks.length;
  if (!confirm('Remove “' + b.title + '” from this device?' + (n ? ' Its ' + n + (n === 1 ? ' bookmark' : ' bookmarks') + ' will be deleted too.' : ''))) return;
  closeSheet($('infoDlg'));
  closeBook();
  state.books = state.books.filter((x) => x !== b);
  save(true);
  await store('remove', b.id).catch(() => {});
  showLibrary();
});
