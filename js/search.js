// The Search sheet: searching the book's text as you type. Each result shows
// its chapter, page and two lines of text; tapped, it opens to its whole
// paragraph. Play finds the place in the audio and plays from there;
// Bookmark makes a bookmark of that text. Recent searches are kept per book.
// Deliberately not a reader: a result opens only as far as its paragraph.

import { estimateTime, placeInAudio } from './figures.js';
import { addTextMark } from './marks.js';
import { cur, play, seek } from './player.js';
import { save } from './state.js';
import { entryAt, pageNumber } from './text/book.js';
import { findMatches, paragraphAround, snippet } from './text/search.js';
import { $, el, fmt, icon, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';

const SHOWN = 50;        // results drawn at first; "Show more" adds this many again
const KEEP = 12;         // recent searches kept per book
let hits = [], shown = 0, timer = null, busy = false, searched = null;   // searched: the book the field was last used for

// The tab button shows once the open book has its text.
export function renderSearchTab() {
  $('searchBtn').hidden = !(cur && cur.text);
}

const history = () => cur.book.searches || (cur.book.searches = []);
function remember(q) {
  q = q.trim().replace(/\s+/g, ' ');
  if (q.length < 2 || !cur) return;
  const h = history().filter((x) => x.toLowerCase() !== q.toLowerCase());
  h.unshift(q);
  cur.book.searches = h.slice(0, KEEP);
  save(true);
}

function renderHistory() {
  const h = cur ? history() : [], ol = $('searchHistory');
  $('searchRecent').hidden = !h.length;
  ol.textContent = '';
  for (const q of h) {
    const btn = el('button', 'recent');
    btn.type = 'button';
    btn.append(icon('M15 15l5 5M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0z'), el('span', '', q));
    btn.addEventListener('click', () => { $('searchInput').value = q; run(); remember(q); });
    const li = el('li'); li.append(btn); ol.append(li);
  }
}

function run() {
  const q = $('searchInput').value.trim();
  const list = $('searchResults');
  list.textContent = '';
  hits = []; shown = 0;
  $('searchRecent').hidden = true;
  if (q.length < 2 || !cur || !cur.text) {
    $('searchStatus').textContent = '';
    if (!q) renderHistory();
    return;
  }
  hits = findMatches(cur.text.text, q);
  $('searchStatus').textContent = hits.length ? (hits.length >= 500 ? '500 or more results' : hits.length === 1 ? '1 result' : hits.length + ' results') : 'Nothing found for “' + q + '”.';
  more();
}

// Draws the next set of results.
function more() {
  const list = $('searchResults'), text = cur.text.text;
  $('searchMore').hidden = true;
  for (const h of hits.slice(shown, shown + SHOWN)) list.append(result(text, h));
  shown = Math.min(hits.length, shown + SHOWN);
  $('searchMore').hidden = shown >= hits.length;
}

const GLYPH_PLAY = 'M7 5v14l11-7z', GLYPH_MARK = 'M7 4h10v16l-5-4-5 4z';
function result(text, h) {
  const li = el('li', 'hit');
  const section = entryAt(cur.meta.toc, h.at), page = entryAt(cur.meta.pages, h.at);
  const main = el('button', 'hitmain'), head = el('span', 'hithead'), body = el('span', 'hittext');
  main.type = 'button';
  head.append(el('span', '', section ? section.label : ''), el('span', 'muted', page && pageNumber(page.label) ? 'p. ' + pageNumber(page.label) : ''));
  const fill = (open) => {
    const s = open ? (() => { const p = paragraphAround(text, h.at); return { pre: text.slice(p.a, h.at), hit: text.slice(h.at, h.end), post: text.slice(h.end, p.z) }; })()
      : snippet(text, h.at, h.end);
    body.replaceChildren(s.pre, el('b', '', s.hit), s.post);
    li.classList.toggle('open', open);
    main.setAttribute('aria-expanded', String(open));
  };
  fill(false);
  main.append(head, body);
  main.addEventListener('click', () => { fill(!li.classList.contains('open')); remember($('searchInput').value); });

  const acts = el('div', 'acts');
  const go = el('button'), mark = el('button');
  go.type = mark.type = 'button';
  go.setAttribute('aria-label', 'Play from here'); go.append(icon(GLYPH_PLAY));
  mark.setAttribute('aria-label', 'Bookmark this'); mark.append(icon(GLYPH_MARK));
  go.addEventListener('click', () => act(h, 'play'));
  mark.addEventListener('click', () => act(h, 'mark'));
  acts.append(go, mark);
  li.append(main, acts);
  return li;
}

// Play and Bookmark both need the time this text is read at, which takes a
// few seconds of listening (placeInAudio). A bookmark falls back to an
// estimate if the place can't be found; playing doesn't guess.
async function act(h, what) {
  if (busy || !cur) return;
  remember($('searchInput').value);
  const mine = cur, say = (msg) => { $('searchStatus').textContent = msg; };
  busy = true; $('searchDlg').classList.add('finding');
  let t;
  try { t = await placeInAudio(h.at, say); } finally { busy = false; $('searchDlg').classList.remove('finding'); }
  if (cur !== mine) return;
  if (what === 'play') {
    if (t == null) return;
    seek(t); play();
    closeSheet($('searchDlg'));
    toast('Playing from ' + fmt(t));
  } else {
    const found = t != null;
    if (!found) t = estimateTime(h.at);
    addTextMark(h.at, h.end, t);
    say('');
    toast(found ? 'Bookmarked ' + fmt(t) : 'Bookmarked; the time ' + fmt(t) + ' is an estimate');
  }
}

$('searchBtn').addEventListener('click', () => {
  if (searched !== cur.book) { searched = cur.book; $('searchInput').value = ''; }
  $('searchDlg').showModal();
  $('searchInput').focus();
  if (!$('searchInput').value) run(); else $('searchDlg').scrollTop = 0;
});
$('searchInput').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); remember($('searchInput').value); $('searchInput').blur(); }
});
$('searchMore').addEventListener('click', more);
$('searchClear').addEventListener('click', () => { if (cur) { cur.book.searches = []; save(true); } renderHistory(); });
$('searchClose').addEventListener('click', () => closeSheet($('searchDlg')));
