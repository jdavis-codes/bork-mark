// Bookmarks: making one, and the Bookmarks sheet with a card for each.

import { chapterAt, cur, play, seek } from './player.js';
import { runQueue } from './queue.js';
import { requote, shareText } from './quotes.js';
import { sound } from './sounds.js';
import { save, settings } from './state.js';
import { endTrim, paintTrim, pinIcon, startTrim, trim, trimEditor } from './trim.js';
import { $, audio, calm, el, fmt, icon, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';
import { openFigure, showPdfPage } from './viewer.js';
import { log } from './log.js';
import { relatedMarks } from './meaning.js';

const MERGE_WINDOW = 3000;                 // repeated presses within this many ms count once

// ---------- bookmarks ----------
let lastMarkAt = 0;
export function addMark() {
  if (!cur) return;
  const now = Date.now();
  if (now - lastMarkAt < MERGE_WINDOW) return;
  lastMarkAt = now;
  const t = audio.currentTime || cur.book.position || 0;
  cur.book.marks.unshift({ id: crypto.randomUUID(), t, created: now, status: 'pending' });
  log('bookmark at ' + fmt(t));
  sound('mark');
  save(true);
  renderMarks();
  toast('Bookmarked ' + fmt(t));
  $('markBtn').classList.add('flash');
  setTimeout(() => $('markBtn').classList.remove('flash'), 180);
  runQueue();
}
$('markBtn').addEventListener('click', addMark);

// A bookmark made from the text rather than the audio, from a search result:
// characters [at, end) of the book text, read at time t. Its quote is cut
// from the text straight away; no listening needed.
export function addTextMark(at, end, t) {
  if (!cur || !cur.text) return;
  const starts = cur.text.starts, word = (pos) => { let lo = 0, hi = starts.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < pos) lo = mid + 1; else hi = mid; } return lo; };
  const i = Math.min(word(at), starts.length - 1), j = Math.max(i + 1, Math.min(word(end), starts.length));
  const m = { id: crypto.randomUUID(), t, created: Date.now(), status: 'done', loc: [i, i, j], confidence: 1 };
  requote(m, cur.text);
  cur.book.marks.unshift(m);
  log('bookmark from search at ' + fmt(t));
  sound('mark');
  save(true);
  renderMarks();
}

// ---------- bookmarks list ----------
export const expanded = new Set();
const STATUS = {
  pending: 'Waiting to find the quote', working: 'Finding the quote…', transcribed: 'Heard, no book text yet',
  nomatch: 'Not in the book text', error: 'Could not find the quote',
};
const GLYPH = {
  play: 'M7 5v14l11-7z',
  trim: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.1 8.1L20 20M8.1 15.9L20 4',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  table: 'M4 6h16v12H4zM4 10h16M4 14h16M10 6v12',
  picture: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4 3-3L20 17',
};
const iconButton = (glyph, label, cls) => {
  const b = el('button', cls || '');
  b.type = 'button'; b.setAttribute('aria-label', label); b.append(icon(GLYPH[glyph]));
  return b;
};
const SENTENCE_END = /[.!?…]+["”’)\]]*\s+/g;
// The text before the bookmark point, split where its last sentence begins.
function splitBefore(before) {
  let cut = before.lastIndexOf('\n') + 1;
  SENTENCE_END.lastIndex = cut;
  for (let m; (m = SENTENCE_END.exec(before));) cut = m.index + m[0].length;
  return [before.slice(0, cut), before.slice(cut)];
}
// The text after the point, split where that sentence ends.
function splitAfter(after) {
  const m = /[.!?…]+["”’)\]]*(?=\s|$)|\n/.exec(after);
  const cut = m ? m.index + (m[0] === '\n' ? 0 : m[0].length) : after.length;
  return [after.slice(0, cut), after.slice(cut)];
}
// For a closed card: only the sentence or so leading up to the bookmarked one.
function leadIn(text) {
  if (text.length <= 150) return text;
  const cut = text.slice(-150), i = cut.search(/[.!?…]\s/);
  return '… ' + (i >= 0 ? cut.slice(i + 2) : cut.slice(cut.indexOf(' ') + 1));
}

// What the search field in the sheet's heading holds: cards are shown only if
// every word typed appears in the quote (or what was heard), the chapter or
// the section, and those words are marked in the cards.
let filter = '';
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function matches(b, m) {
  const words = fold(filter).split(/\s+/).filter(Boolean);
  const c = chapterAt(b, m.t), hay = fold([m.before, m.after, m.transcript, c.count > 1 ? c.title : '', m.section].filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}
// Wraps the filter's words in <mark> inside the given elements.
function markWords(nodes) {
  const words = fold(filter).split(/\s+/).filter(Boolean);
  if (!words.length) return;
  for (const root of nodes) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), texts = [];
    for (let n; (n = walker.nextNode());) texts.push(n);
    for (const t of texts) {
      const s = t.data, f = fold(s);
      if (f.length !== s.length) continue;   // folding changed the length: leave this piece unmarked
      const hits = [];
      for (const w of words) for (let k = f.indexOf(w); k >= 0; k = f.indexOf(w, k + w.length)) hits.push([k, k + w.length]);
      if (!hits.length) continue;
      hits.sort((x, y) => x[0] - y[0]);
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, z] of hits) {
        if (a < pos) continue;
        frag.append(s.slice(pos, a), el('mark', '', s.slice(a, z)));
        pos = z;
      }
      frag.append(s.slice(pos));
      t.replaceWith(frag);
    }
  }
}

// The orders the list can be in. Book order (by place in the book) puts the
// cards under chapter headings; the rest are one list, each card naming its
// chapter. Lengths are of the quote, or of what was heard; bookmarks with
// neither yet go last. Needs attention puts first the ones to retry or check:
// failed, not found in the text, heard only, still waiting.
const quoteLength = (m) => ((m.before || '') + (m.after || '') || m.transcript || '').length;
const byLength = (dir) => (x, y) => (!quoteLength(x) - !quoteLength(y)) || dir * (quoteLength(x) - quoteLength(y));
const ATTENTION = { error: 0, nomatch: 1, transcribed: 2, pending: 3, working: 3, done: 4 };
const ORDERS = {
  book: (x, y) => x.t - y.t,
  new: (x, y) => y.created - x.created,
  old: (x, y) => x.created - y.created,
  long: byLength(-1),
  short: byLength(1),
  attention: (x, y) => (ATTENTION[x.status] ?? 4) - (ATTENTION[y.status] ?? 4) || y.created - x.created,
};

export function renderMarks() {
  if (!cur) return;
  const b = cur.book, list = $('marks');
  const n = b.marks.length, waiting = b.marks.filter((m) => m.status === 'pending' || m.status === 'working').length;
  list.textContent = '';
  $('markCount').textContent = n ? '(' + n + ')' : '';
  $('marksLabel').textContent = n ? String(n) : '';
  $('marksBtn').setAttribute('aria-label', 'Bookmarks' + (n ? ', ' + n : '') + (waiting ? ', ' + waiting + ' still being processed' : ''));
  $('marksBtn').classList.toggle('on', waiting > 0);
  const order = ORDERS[settings.markOrder] ? settings.markOrder : 'book';
  $('markOrder').value = order;
  $('markSort').classList.toggle('on', order !== 'book');
  $('markSort').hidden = n < 2;   // nothing to put in order
  // The cards are only built while the sheet is open (opening it renders them),
  // so quotes arriving during playback just update the counts.
  if (!$('marksDlg').open) { list.textContent = ''; return; }
  if (!n) {
    list.append(el('p', 'muted', 'None yet. Press Bookmark, or next / previous track on your headphones or watch.'));
    return;
  }
  const shown = filter.trim() ? b.marks.filter((m) => matches(b, m)) : b.marks;
  if (!shown.length) {
    list.append(el('p', 'muted', 'No bookmarks contain “' + filter.trim() + '”.'));
  } else if (order !== 'book') {
    const group = el('div', 'group');
    [...shown].sort(ORDERS[order]).forEach((m) => group.append(markCard(b, m, true)));
    list.append(group);
  } else {
    // In book order, under a heading for each chapter that has bookmarks.
    let group = null, last = null, count = null, inGroup = 0;
    for (const m of [...shown].sort((x, y) => x.t - y.t)) {
      const c = chapterAt(b, m.t);
      if (c.i !== last) {
        if (count) count.textContent = String(inGroup);
        group = el('div', 'group'); last = c.i; inGroup = 0;
        const head = el('div', 'grouphead');
        count = el('span');
        head.append(el('span', '', c.count > 1 ? c.title : b.title), count);
        group.append(head); list.append(group);
      }
      inGroup++;
      group.append(markCard(b, m, false));
    }
    if (count) count.textContent = String(inGroup);
  }
  if (filter.trim()) {
    showRelated(b, list, new Set(shown.map((m) => m.id)));
    markWords(list.querySelectorAll('.quote, .where, .grouphead span:first-child'));   // any word typed, in related ones too
  }
  if (trim) paintTrim();
}

// ---- related by meaning ----
// Below the bookmarks that contain the words, the ones about the same thing
// (see meaning.js), found a moment after typing stops. The first search loads
// the sentence model, so it can take a few seconds.
let related = null, relatedTimer = null;   // related: { query, list, busy, error }
function findRelated() {
  clearTimeout(relatedTimer);
  const q = filter.trim();
  if (related && related.query !== q) related = null;
  if (q.length < 3 || !cur || (related && related.query === q)) return;
  relatedTimer = setTimeout(async () => {
    const mine = cur, skip = new Set(mine.book.marks.filter((m) => matches(mine.book, m)).map((m) => m.id));
    related = { query: q, list: [], busy: true };
    renderMarks();
    let found = [], error = '';
    try { found = await relatedMarks(mine.book, q, skip); } catch (err) { error = (err && err.message) || String(err); }
    if (cur !== mine || filter.trim() !== q) return;
    related = { query: q, list: found, error };
    renderMarks();
  }, 450);
}
function showRelated(b, list, skip) {
  if (!related || related.query !== filter.trim()) return;
  const group = el('div', 'group related'), head = el('div', 'grouphead');
  const items = related.list.filter((r) => !skip.has(r.m.id) && b.marks.includes(r.m));
  head.append(el('span', '', 'Related by meaning'), el('span', '', related.busy ? '' : String(items.length)));
  group.append(head);
  if (related.busy) group.append(el('p', 'muted relatednote', 'Looking for bookmarks about the same thing…'));
  else if (related.error) group.append(el('p', 'muted relatednote', 'Couldn’t look for related bookmarks: ' + related.error));
  else if (!items.length) group.append(el('p', 'muted relatednote', 'Nothing else about this.'));
  for (const r of items) group.append(markCard(b, r.m, true));
  list.append(group);
}
// The magnifier in the heading swaps the title for a search field; Cancel (or
// closing the sheet) clears it and shows every bookmark again.
function setFilter(value) { filter = value; renderMarks(); findRelated(); }
$('marksSearchBtn').addEventListener('click', () => {
  $('marksDlg').classList.add('searching');
  $('marksSearchInput').value = filter; $('marksSearchInput').focus();
});
$('marksSearchInput').addEventListener('input', (e) => setFilter(e.target.value));
$('marksSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('marksSearchCancel').click(); } });
$('marksSearchCancel').addEventListener('click', () => { $('marksSearchInput').value = ''; $('marksDlg').classList.remove('searching'); setFilter(''); });
$('marksDlg').addEventListener('close', () => { if (filter) $('marksSearchCancel').click(); });
$('markOrder').addEventListener('change', (e) => { settings.markOrder = e.target.value; save(true); renderMarks(); });

// ---- motion in the list ----
const cardFor = (id) => Array.from(document.querySelectorAll('#marks .mark')).find((n) => n.dataset.id === id);
// Runs `change` (which redraws the list), then eases that card from the height
// it had to the height it has now, so it opens or closes instead of jumping.
export function easeCard(id, change, settle) {
  const old = cardFor(id), from = old ? old.getBoundingClientRect().height : null;
  change();
  const card = cardFor(id);
  if (!card) return;
  const to = card.getBoundingClientRect().height;
  if (settle) {
    // After an edit: bring this bookmark back into view and light it up briefly.
    // If it fits, it sits in the middle of the space under the heading; if it
    // is taller than that, its top line (date and time) goes just under the heading.
    const sheet = $('marksDlg'), frame = sheet.getBoundingClientRect();
    const top = card.getBoundingClientRect().top - frame.top + sheet.scrollTop;
    const head = sheet.querySelector('.markshead'), chapter = card.parentNode.querySelector('.grouphead');   // both stay pinned at the top
    const under = (head ? head.getBoundingClientRect().height : 0) + (chapter ? chapter.getBoundingClientRect().height : 0);
    const room = sheet.clientHeight - under;
    const target = to + 24 <= room ? top - under - (room - to) / 2 : top - under - 10;
    sheet.scrollTo({ top: Math.max(0, target), behavior: calm.matches ? 'auto' : 'smooth' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1700);
  }
  if (from == null || calm.matches || Math.abs(to - from) < 2) return;
  card.style.height = from + 'px'; card.style.overflow = 'hidden';
  card.getBoundingClientRect();                       // start the transition from here
  card.style.transition = 'height 0.26s cubic-bezier(0.2, 0.8, 0.2, 1)';
  card.style.height = to + 'px';
  setTimeout(() => { card.style.height = ''; card.style.overflow = ''; card.style.transition = ''; if (trim) paintTrim(); }, 280);
}
// Deleting: the card fades and folds away, and the ones below slide up into
// its place. If it was the only one under its chapter heading, the heading goes with it.
function removeCard(b, m) {
  const finish = () => { b.marks = b.marks.filter((x) => x !== m); save(true); renderMarks(); };
  const card = cardFor(m.id);
  if (!card || calm.matches) { finish(); return; }
  const group = card.parentNode, gone = group.querySelectorAll('.mark').length === 1 && b.marks.length > 1 ? group : card;
  gone.style.height = gone.getBoundingClientRect().height + 'px'; gone.style.overflow = 'hidden';
  gone.getBoundingClientRect();
  gone.style.transition = 'height 0.28s cubic-bezier(0.3, 0.7, 0.3, 1), padding 0.28s, margin 0.28s, border-width 0.28s, opacity 0.18s, transform 0.28s';
  gone.style.height = '0px'; gone.style.paddingTop = '0px'; gone.style.paddingBottom = '0px'; gone.style.marginBottom = '0px'; gone.style.borderWidth = '0px';
  gone.style.opacity = '0'; gone.style.transform = 'translateX(-16px)';
  setTimeout(finish, 290);
}

function markCard(b, m, showChapter) {
  const card = el('div', 'mark'), c = chapterAt(b, m.t);
  card.dataset.id = m.id;
  const top = el('div', 'marktop');
  const day = new Date(m.created).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  top.append(el('span', 'where', STATUS[m.status] || (showChapter && c.count > 1 ? c.title : day)));
  const pill = el('button', 'playpill');
  pill.type = 'button'; pill.setAttribute('aria-label', 'Play from just before ' + fmt(m.t));
  pill.append(icon(GLYPH.play), document.createTextNode(fmt(m.t)));
  pill.addEventListener('click', () => { seek(m.t - 30); play(); closeSheet($('marksDlg')); });
  top.append(pill);
  card.append(top);

  const remove = iconButton('trash', 'Delete bookmark');
  remove.addEventListener('click', () => {
    if (!confirm('Delete the bookmark at ' + fmt(m.t) + '?')) return;
    endTrim(m);
    removeCard(b, m);
  });
  const foot = el('div', 'markfoot'), chips = el('div', 'chips'), acts = el('div', 'acts');

  if (m.status === 'pending' || m.status === 'working') {
    const skeleton = el('div', 'skeleton');
    skeleton.append(el('i'), el('i'), el('i'));
    acts.append(remove); foot.append(chips, acts);
    card.append(skeleton, foot);
    return card;
  }
  if (m.status === 'error') {
    card.append(el('p', 'warn', m.error || 'Something went wrong.'));
    const retry = el('button', 'small', 'Try again');
    retry.addEventListener('click', () => { m.status = 'pending'; delete m.error; save(true); renderMarks(); runQueue(); });
    chips.append(retry); acts.append(remove); foot.append(chips, acts);
    card.append(foot);
    return card;
  }
  const copy = iconButton('copy', 'Copy quote');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareText(b, m)); toast('Copied'); } catch (e) { toast('Copy failed'); }
  });
  const share = navigator.share ? iconButton('share', 'Share quote') : null;   // the system share sheet: Are.na, Notes, Messages…
  if (share) share.addEventListener('click', () => {
    navigator.share({ text: shareText(b, m) }).catch((e) => { if (e.name !== 'AbortError') toast('Could not share'); });
  });

  if (m.status !== 'done') {   // heard, but not matched to book text
    card.append(el('p', 'quote heard', '“' + (m.transcript || '') + '”'));
    chips.append(el('span', 'muted small', b.hasText ? 'Shown as heard.' : 'Shown as heard. Add the book text for the exact wording.'));
    if (share) acts.append(share);
    acts.append(copy, remove); foot.append(chips, acts);
    card.append(foot);
    return card;
  }
  if (trim && trim.m === m) { card.classList.add('trimming'); card.append(trimEditor()); return card; }

  // The quote, with a tick at the bookmark point and that sentence lightly
  // marked. Closed, it opens on the lead-in to that sentence; tap for all of it.
  const open = expanded.has(m.id) || !!filter.trim();
  const [lead, sentStart] = splitBefore(m.before), [sentEnd, rest] = splitAfter(m.after);
  const quote = el('p', 'quote' + (open ? '' : ' clamped'));
  // Closed, at most about 170 characters come before the bookmark icon, so it is always among the lines shown.
  const ROOM = 170;
  const shownLead = open ? lead : sentStart.length >= ROOM ? '' : leadIn(lead).slice(-(ROOM - sentStart.length)).replace(/^\S*\s/, (cut) => (leadIn(lead).length > ROOM - sentStart.length ? '… ' : cut));
  const shownStart = open || sentStart.length < ROOM ? sentStart : '… ' + sentStart.slice(sentStart.indexOf(' ', sentStart.length - ROOM) + 1);
  quote.append(document.createTextNode(shownLead), el('span', 'pinned', shownStart), pinIcon(), el('span', 'pinned', sentEnd), document.createTextNode(rest));
  quote.setAttribute('role', 'button'); quote.tabIndex = 0;
  quote.setAttribute('aria-label', (open ? 'Collapse' : 'Show all of') + ' this quote');
  const toggle = () => easeCard(m.id, () => { if (open) expanded.delete(m.id); else expanded.add(m.id); renderMarks(); });
  quote.addEventListener('click', toggle);
  quote.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  card.append(quote);

  if (m.page) {
    const canShow = m.pdfPage != null && b.hasPagePdf;
    const page = el(canShow ? 'button' : 'span', 'chip', 'p. ' + m.page);
    if (canShow) { page.setAttribute('aria-label', 'Show scanned page ' + m.page); page.addEventListener('click', () => { if (cur.pageSrc) showPdfPage(m.pdfPage); else toast('The page scan is still loading'); }); }
    chips.append(page);
  }
  for (const i of m.figs || []) {
    const f = cur.meta.figures[i];
    if (!f) continue;
    const fig = el('button', 'chip');
    fig.append(icon(GLYPH[f.kind === 'table' ? 'table' : 'picture']), document.createTextNode(f.kind === 'table' ? 'Table' : 'Picture'));
    fig.setAttribute('aria-label', (f.kind === 'table' ? 'Table: ' : 'Picture: ') + (f.cap || 'no caption'));
    fig.addEventListener('click', () => openFigure(i));
    chips.append(fig);
  }
  if (cur.text) {
    const cut = iconButton('trim', 'Trim quote', 'primary');
    cut.addEventListener('click', () => startTrim(m));
    acts.append(cut);
  }
  if (share) acts.append(share);
  acts.append(copy, remove);
  foot.append(chips, acts);
  card.append(foot);
  return card;
}

// ---------- opening and closing the sheet ----------
$('marksBtn').addEventListener('click', () => { $('marksDlg').showModal(); renderMarks(); $('marksDlg').scrollTop = 0; });
$('marksClose').addEventListener('click', () => closeSheet($('marksDlg')));
