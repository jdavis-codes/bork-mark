// Trimming a quote to the sentences wanted, inside its card in the Bookmarks sheet.

import { easeCard, expanded, renderMarks } from './marks.js';
import { cur } from './player.js';
import { requote } from './quotes.js';
import { save, settings } from './state.js';
import { findInBook, tokenize } from './text/book.js';
import { quoteAt, sentencesIn } from './text/quote.js';
import { $, calm, el, icon, toast } from './ui/dom.js';

// The quote being trimmed is shown with some of the book either side. Its
// start and end are character positions: a handle follows the finger word by
// word, and on letting go the edge settles on the nearest sentence boundary
// (unless that is switched off in Settings). Tapping also moves an edge. The
// bookmark point itself always stays inside the quote.
export let trim = null;   // { m, from, to, sents, anchor, point, pointEnd, a, b, base: [a, b] }
// Stops trimming: any quote, or only bookmark m (when it is being deleted).
export function endTrim(m) { if (trim && (!m || trim.m === m)) trim = null; }
const pointOf = (m) => cur.text.starts[Math.min(m.loc[1], cur.text.starts.length - 1)];
const bare = (str) => str.replace(/^…\s*/, '').replace(/\s*…$/, '');
// A small bookmark shape, drawn inline at the place the button was pressed.
export function pinIcon() {
  const pin = el('span', 'pin'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '6 3 12 18'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 4h10v16l-5-4-5 4z');
  svg.append(path); pin.append(svg);
  pin.setAttribute('role', 'img'); pin.setAttribute('aria-label', 'bookmarked here');
  return pin;
}
export function startTrim(m) {
  const text = cur.text;
  if (!m.loc) {   // an older bookmark: find its quote in the book text first
    const before = tokenize(m.before).words, loc = findInBook(text, before.concat(tokenize(m.after).words), before.length);
    if (!loc) { toast('Quote not found in the text', 'warn'); return; }
    m.loc = [loc.start, loc.split, loc.end];
  }
  const at = pointOf(m);
  const a = m.trim ? m.trim[0] : at - bare(m.before).length, b = m.trim ? m.trim[1] : at + bare(m.after).length;
  trim = { m, from: Math.min(a, at) - 900, to: Math.max(b, at) + 900, a, b };
  layoutTrim();
  easeCard(m.id, renderMarks);
  const card = document.querySelector('.mark.trimming');
  if (card) card.scrollIntoView({ block: 'start', behavior: calm.matches ? 'auto' : 'smooth' });
}
// Works out the sentences in view, and the limits the two edges must respect.
function layoutTrim() {
  const text = cur.text, at = pointOf(trim.m);
  const S = trim.sents = sentencesIn(text.text, Math.max(0, trim.from), Math.min(text.text.length, trim.to));
  trim.point = at;
  trim.pointEnd = at + ((/^\S+/.exec(text.text.slice(at, at + 80)) || [' '])[0].length);   // end of the word at the point
  trim.anchor = S.findIndex((x) => at < x.b);
  if (trim.anchor < 0) trim.anchor = S.length - 1;
  // What the capture setting alone would give, for the "As captured" shortcut.
  const q = quoteAt(text, { start: trim.m.loc[0], split: trim.m.loc[1], end: trim.m.loc[2] }, settings.capture);
  trim.base = [at - bare(q.before).length, at + bare(q.after).length];
  setTrim(trim.a, trim.b);
}
// The start can be anywhere up to the point, the end anywhere from the end of its word.
function setTrim(a, b) {
  const S = trim.sents;
  trim.a = Math.max(S[0].a, Math.min(a, trim.point));
  trim.b = Math.min(S[S.length - 1].b, Math.max(b, trim.pointEnd));
}
export function trimEditor() {
  const S = trim.sents, text = cur.text.text, box = el('div', 'trimmer');
  const presets = el('div', 'presets');
  const preset = (label, id, range) => {
    const btn = el('button', '', label);
    btn.type = 'button'; btn.id = id;
    btn.addEventListener('click', () => {
      const [a, b] = range();
      // the capture may reach beyond the text on screen: bring that text in first
      if (a < S[0].a || b > S[S.length - 1].b) { trim.from = Math.min(trim.from, a - 200); trim.to = Math.max(trim.to, b + 200); trim.a = a; trim.b = b; layoutTrim(); renderMarks(); return; }
      setTrim(a, b); paintTrim();
    });
    presets.append(btn);
  };
  const first = S.findIndex((x) => x.p === S[trim.anchor].p), last = S.length - 1 - [...S].reverse().findIndex((x) => x.p === S[trim.anchor].p);
  trim.sentence = [S[trim.anchor].a, S[trim.anchor].b];
  trim.para = [S[first].a, S[last].b];
  preset('Sentence', 'trimSentence', () => trim.sentence);
  preset('Paragraph', 'trimPara', () => trim.para);
  preset('As captured', 'trimBase', () => trim.base);
  box.append(el('p', 'muted small', settings.trimSnap ? 'Tap a sentence, drag a handle, or press and hold anywhere to drag from there. The ends settle on whole sentences.' : 'Tap a word, drag a handle, or press and hold anywhere to drag from there.'), presets);

  const widen = (label, grow) => {
    const btn = el('button', 'more');
    btn.type = 'button'; btn.setAttribute('aria-label', label); btn.append(icon('M12 5v14M5 12h14'));
    btn.addEventListener('click', () => { grow(); layoutTrim(); renderMarks(); });
    return btn;
  };
  if (trim.from > 0) box.append(widen('Show earlier text', () => { trim.from -= 1400; }));
  // Every word is its own piece, so the highlight and the handles can follow a finger word by word.
  const passage = el('div', 'passage');
  let p = null, lastPara = -1, pinned = false;
  // The words and their character ranges are kept as numbers too, so redrawing
  // during a drag doesn't re-read hundreds of data attributes.
  const words = passage.words = [];
  S.forEach((x, i) => {
    if (x.p !== lastPara) { p = el('p'); passage.append(p); lastPara = x.p; }
    const sent = el('span', 'sent' + (i === trim.anchor ? ' anchor' : ''));
    sent.dataset.i = i;
    const body = text.slice(x.a, x.b), word = /\S+\s*/g;
    for (let m; (m = word.exec(body));) {
      const a = x.a + m.index, b = a + m[0].trimEnd().length, w = el('span', 'w', m[0]);
      w.dataset.a = a; w.dataset.b = b;
      words.push({ node: w, a, b });
      if (!pinned && a >= trim.point) { sent.append(pinIcon()); pinned = true; }
      sent.append(w);
    }
    p.append(sent, document.createTextNode(' '));
  });
  holdToDrag(passage);
  passage.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (passage.dataset.justDragged) { delete passage.dataset.justDragged; return; }
    if (!w) return;
    tapWord(Number(w.dataset.a), Number(w.dataset.b), Number(w.parentNode.dataset.i));
    paintTrim();
  });
  for (const edge of ['start', 'end']) {
    const h = el('span', 'handle ' + edge);
    h.setAttribute('role', 'slider'); h.tabIndex = 0;
    h.setAttribute('aria-label', edge === 'start' ? 'Start of quote' : 'End of quote');
    h.addEventListener('pointerdown', (e) => dragHandle(e, edge, h, passage));
    h.addEventListener('keydown', (e) => {   // arrow keys step an edge by a sentence, or by a word when not snapping
      const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      e.preventDefault(); stepEdge(edge, step, passage); paintTrim();
    });
    passage.append(h);
  }
  box.append(passage);
  if (trim.to < text.length) box.append(widen('Show later text', () => { trim.to += 1400; }));

  const bar = el('div', 'trimbar'), count = el('span', 'count'), buttons = el('div', 'row');
  count.id = 'trimCount';
  const cancel = el('button', '', 'Cancel'), keep = el('button', 'primary', 'Save');
  cancel.addEventListener('click', () => { const id = trim.m.id; easeCard(id, () => { trim = null; renderMarks(); }, true); });
  keep.addEventListener('click', saveTrim);
  buttons.append(cancel, keep); bar.append(count, buttons); box.append(bar);
  return box;
}
// The sentence boundaries an edge may rest on: starts up to the bookmarked
// sentence for the start, ends from it onward for the end.
const sentenceStops = (edge) => (edge === 'start' ? trim.sents.slice(0, trim.anchor + 1).map((x) => x.a) : trim.sents.slice(trim.anchor).map((x) => x.b));
const nearest = (stops, value) => stops.reduce((best, x) => (Math.abs(x - value) < Math.abs(best - value) ? x : best), stops[0]);
function snapEdge(edge) {
  if (edge === 'start') setTrim(nearest(sentenceStops('start'), trim.a), trim.b); else setTrim(trim.a, nearest(sentenceStops('end'), trim.b));
}
function stepEdge(edge, step, passage) {
  const stops = settings.trimSnap ? sentenceStops(edge) : passage.words.map((w) => (edge === 'start' ? w.a : w.b));
  const at = stops.indexOf(nearest(stops, edge === 'start' ? trim.a : trim.b));
  const next = stops[Math.max(0, Math.min(stops.length - 1, at + step))];
  if (edge === 'start') setTrim(next, trim.b); else setTrim(trim.a, next);
}
// A tap before the bookmark point moves the start, after it the end. A tap on
// the bookmarked sentence (or word) pulls the end in to it, and tapped again
// pulls the start in.
function tapWord(a, b, sentence) {
  if (settings.trimSnap) {
    const S = trim.sents, here = S[trim.anchor];
    if (sentence < trim.anchor) setTrim(S[sentence].a, trim.b);
    else if (sentence > trim.anchor) setTrim(trim.a, S[sentence].b);
    else if (trim.b > here.b) setTrim(trim.a, here.b);
    else setTrim(here.a, trim.b);
  } else if (a < trim.point) setTrim(a, trim.b);
  else if (b > trim.pointEnd) setTrim(trim.a, b);
  else if (trim.b > trim.pointEnd) setTrim(trim.a, trim.pointEnd);
  else setTrim(trim.point, trim.b);
}
// Updates the highlight, handles, count and shortcuts without rebuilding the
// card, so a drag in progress is not interrupted.
export function paintTrim() {
  const passage = document.querySelector('.trimmer .passage');
  if (!trim || !passage) return;
  let first = null, last = null, words = 0;
  for (const w of passage.words) {
    const on = w.a >= trim.a && w.b <= trim.b;
    if (w.node.classList.contains('in') !== on) w.node.classList.toggle('in', on);
    if (on) { words++; first = first || w; last = w; }
  }
  if (first) {
    // measured on the letters alone, so the end handle sits right after the last one
    const box = passage.getBoundingClientRect(), letters = (w) => { const r = document.createRange(), t = w.node.firstChild; r.setStart(t, 0); r.setEnd(t, w.b - w.a); return r.getClientRects(); };
    const head = letters(first)[0], tails = letters(last), tail = tails[tails.length - 1];
    const place = (h, x, rect) => {
      h.style.transform = 'translate(' + (x - box.left) + 'px, ' + (rect.top - box.top) + 'px)';
      if (h.style.height !== rect.height + 'px') h.style.height = rect.height + 'px';
    };
    if (head && tail) { place(passage.querySelector('.handle.start'), head.left, head); place(passage.querySelector('.handle.end'), tail.right, tail); }
  }
  const n = trim.sents.filter((x) => x.b > trim.a && x.a < trim.b).length;
  $('trimCount').textContent = n + (n === 1 ? ' sentence' : ' sentences') + ' · ' + words + ' words';
  const is = (r) => trim.a === r[0] && trim.b === r[1];
  $('trimSentence').setAttribute('aria-pressed', String(is(trim.sentence)));
  $('trimPara').setAttribute('aria-pressed', String(is(trim.para) && !is(trim.sentence)));
  $('trimBase').setAttribute('aria-pressed', String(is(trim.base) && !is(trim.sentence) && !is(trim.para)));
}
window.addEventListener('resize', () => { if (trim) paintTrim(); });
// Moving an edge by dragging. Used by the handles, and by pressing and
// holding anywhere in the text. The edge follows the word under the finger;
// held near the top or bottom of the sheet the list keeps scrolling; on
// letting go the edge settles on a sentence boundary (if snapping is on).
// Finger movements are only noted as they arrive; the work happens once per
// frame, however often the screen reports touches (120 Hz screens send twice
// as many as there are frames to draw at 60).
function beginDrag(edge, passage, x, y, offsetY) {
  const sheet = $('marksDlg');
  let at = { x, y }, moved = false, raf = 0, prev = 0;
  const follow = () => {
    const w = document.elementsFromPoint(at.x, at.y + offsetY).find((n) => n.classList && n.classList.contains('w') && passage.contains(n));
    if (!w) return;
    const a = trim.a, b = trim.b, box = w.getBoundingClientRect(), pastMiddle = at.x > box.left + box.width / 2;
    // the start goes before the word under the finger, or after it once past its middle; the end likewise
    if (edge === 'start') setTrim(pastMiddle ? Number(w.dataset.b) + 1 : Number(w.dataset.a), b);
    else setTrim(a, pastMiddle ? Number(w.dataset.b) : Number(w.dataset.a) - 1);
    if (trim.a !== a || trim.b !== b) paintTrim();
  };
  const tick = (now) => {
    // Near the top or bottom of the sheet, the list creeps along (about 600 px a second).
    const frame = sheet.getBoundingClientRect(), dt = prev ? Math.min(50, now - prev) : 16;
    prev = now;
    const dir = at.y < frame.top + 90 ? -1 : at.y > frame.bottom - 110 ? 1 : 0;
    if (dir) { sheet.scrollTop += dir * 0.6 * dt; moved = true; }
    if (moved) { moved = false; follow(); }
    raf = requestAnimationFrame(tick);
  };
  passage.querySelector('.handle.' + edge).classList.add('dragging');
  follow();
  raf = requestAnimationFrame(tick);
  return {
    move(nx, ny) { at = { x: nx, y: ny }; moved = true; },
    end() {
      cancelAnimationFrame(raf);
      if (moved) follow();
      const handle = passage.querySelector('.handle.' + edge);
      if (handle) handle.classList.remove('dragging');
      if (settings.trimSnap && trim) { passage.classList.add('settling'); snapEdge(edge); paintTrim(); setTimeout(() => passage.classList.remove('settling'), 220); }
    },
  };
}
function dragHandle(e, edge, handle, passage) {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const rect = handle.getBoundingClientRect();
  const drag = beginDrag(edge, passage, e.clientX, e.clientY, rect.top + rect.height / 2 - e.clientY);   // offset: finger to the middle of the line
  const move = (ev) => drag.move(ev.clientX, ev.clientY);
  const stop = () => {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop);
    drag.end();
  };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
}
// Press and hold on the text to pick up the nearer edge from anywhere: the
// start if the finger is before the bookmark point, the end if after. A touch
// that moves straight away is a scroll and is left alone, so the two don't clash.
const HOLD_MS = 280;
function holdToDrag(passage) {
  let hold = null;
  const cancel = () => { if (hold) { clearTimeout(hold.timer); if (hold.drag) hold.drag.end(); hold = null; } };
  passage.addEventListener('touchstart', (e) => {
    cancel();
    const w = e.target.closest && e.target.closest('.w');
    if (!w || e.touches.length !== 1) return;
    const t = e.touches[0];
    hold = { x: t.clientX, y: t.clientY, drag: null };
    hold.timer = setTimeout(() => {
      if (!hold || !trim) return;
      const edge = Number(w.dataset.a) < trim.point ? 'start' : 'end';
      hold.drag = beginDrag(edge, passage, hold.x, hold.y, 0);
      passage.dataset.justDragged = '1';      // the tap that ends this press must not also count as a tap
    }, HOLD_MS);
  }, { passive: true });
  passage.addEventListener('touchmove', (e) => {
    if (!hold) return;
    const t = e.touches[0];
    if (hold.drag) { if (e.cancelable) e.preventDefault(); hold.drag.move(t.clientX, t.clientY); return; }
    if (Math.abs(t.clientX - hold.x) > 8 || Math.abs(t.clientY - hold.y) > 8) cancel();   // moved before the hold took: scrolling
    else { hold.x = t.clientX; hold.y = t.clientY; }
  }, { passive: false });
  passage.addEventListener('touchend', cancel);
  passage.addEventListener('touchcancel', cancel);
}
function saveTrim() {
  const m = trim.m;
  // Back at what the capture setting gives: no need to remember a custom trim.
  if (trim.a === trim.base[0] && trim.b === trim.base[1]) delete m.trim; else m.trim = [trim.a, trim.b];
  easeCard(m.id, () => {
    trim = null;
    requote(m, cur.text);
    expanded.add(m.id);
    save(true); renderMarks();
  }, true);
  toast('Quote trimmed');
}
$('marksDlg').addEventListener('close', () => { trim = null; });
