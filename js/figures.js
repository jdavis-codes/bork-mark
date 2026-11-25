// Pictures and tables: knowing where the narration is in the text, announcing each one as it
// is reached, and the Figures sheet.

import { transcribeAround } from './audio/listen.js';
import { naming } from './chapter-names.js';
import { crumb, log } from './log.js';
import { chapterAt, cur, pause, seek } from './player.js';
import { queueBusy, runQueue } from './queue.js';
import { sound } from './sounds.js';
import { modelState, transcribe, warmModel } from './speech.js';
import { chapterNumber, outline, sameChapter } from './sources/extras.js';
import { canWork, save, settings } from './state.js';
import { stored } from './storage.js';
import { entryAt, findInBook } from './text/book.js';
import { $, audio, el, fmt, icon, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';
import { figureName, openFigure } from './viewer.js';

// To chime or pause at a picture, the app has to know which part of the text
// is being read. It keeps "anchors", moments where audio time and text
// position are both known: every bookmark that found its quote is one, and
// while this feature is on the app also listens to a few seconds of the book
// now and then to add more. Between anchors it assumes a steady reading pace.
function anchorList() {
  const b = cur.book, starts = cur.text.starts, list = (b.anchors || []).map(([t, at]) => ({ t, at }));
  for (const m of b.marks) if (m.loc && starts.length) list.push({ t: m.t, at: starts[Math.min(m.loc[1], starts.length - 1)] });
  return list.sort((x, y) => x.t - y.t);
}
// Characters of text read per second of audio around time t. Taken from the
// nearest pair of anchors when there is one; otherwise from the whole book if
// that gives a believable figure, and failing that an ordinary reading speed.
function pace(list, t) {
  let best = null;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], z = list[i], rate = (z.at - a.at) / (z.t - a.t);
    if (z.t - a.t < 20 || !(rate > 6 && rate < 40)) continue;
    const far = Math.min(Math.abs(a.t - t), Math.abs(z.t - t));
    if (!best || far < best.far) best = { far, rate };
  }
  if (best) return best.rate;
  const whole = cur.text.text.length / (cur.book.duration || 1);
  return whole > 9 && whole < 25 ? whole : 15;
}
function textAt(t, list) {
  if (!list.length) return null;
  let lo = null, hi = null;
  for (const a of list) { if (a.t <= t) lo = a; else { hi = a; break; } }
  if (lo && hi) {
    const rate = (hi.at - lo.at) / (hi.t - lo.t);
    if (rate > 6 && rate < 40) return lo.at + (t - lo.t) * rate;
  }
  // Outside the anchors, or between two that disagree: carry on from the nearer one.
  const a = !hi || (lo && t - lo.t <= hi.t - t) ? lo : hi;
  return a.at + (t - a.t) * pace(list, t);
}

const PROBE_EVERY = 300;      // seconds of audio allowed between anchors in normal listening
const PROBE_NEAR = 40;        // …and when a figure is coming up within the next 90 seconds
export let probing = false, probeRest = 0;

// The audio time at which a place in the text is read, judged from the anchors.
function timeAt(at, list) {
  if (!list.length) return null;
  const byText = [...list].sort((x, y) => x.at - y.at);
  let lo = null, hi = null;
  for (const a of byText) { if (a.at <= at) lo = a; else { hi = a; break; } }
  if (lo && hi && hi.t > lo.t) return lo.t + (hi.t - lo.t) * (at - lo.at) / (hi.at - lo.at);
  const a = !hi || (lo && at - lo.at <= hi.at - at) ? lo : hi;
  return a.t + (at - a.at) / pace(list, a.t);
}
// Finds where in the audio a place in the text is read, by listening: guess a
// time, hear what is being read there, see how far off that is in the text,
// correct the guess, and repeat until it is within a few seconds.
async function findInAudio(at, say) {
  const mine = cur, b = mine.book, starts = mine.text.starts;
  let list = anchorList();
  let t = list.length ? timeAt(at, list) : b.duration * at / mine.text.text.length;
  for (let round = 1; round <= 5 && cur === mine; round++) {
    t = Math.max(0, Math.min(b.duration - 20, t));
    say('Finding the place in the audio… (' + round + ')');
    const r = await transcribeAround(mine.source, t + 8, 8, 8, transcribe, crumb);
    crumb(null);
    const loc = findInBook(mine.text, r.words, r.split);
    if (!loc) { t += 40; continue; }                    // nothing recognisable (music, credits): look a little later
    const here = starts[Math.min(loc.split, starts.length - 1)];
    (b.anchors = b.anchors || []).push([Math.round(t + 8), here]);
    if (b.anchors.length > 400) b.anchors.shift();
    save();
    list = anchorList();
    const next = timeAt(at, list);
    if (Math.abs(at - here) < 250) return Math.max(0, next - 3);   // within a few seconds: land just before it
    t = next - 8;
  }
  return null;
}
// Where in the audio a place in the text is read, found by listening (see
// findInAudio): the time, or null when it can't be found or other listening
// is under way. `say` reports progress. Used for figures and search results.
export async function placeInAudio(at, say) {
  if (!cur || !cur.text || !cur.source || probing || queueBusy || naming) { toast('Busy with something else; try again in a moment'); return null; }
  const mine = cur;
  probing = true;
  try {
    await warmModel();
    const t = await findInAudio(at, say);
    if (cur !== mine) return null;
    say(t == null ? 'Could not find this place in the audio.' : '');
    return t;
  } catch (err) {
    say('Stopped: ' + ((err && err.message) || err));
    return null;
  } finally {
    probing = false; crumb(null);
    runQueue();
  }
}
// A guess at the time, from the places already known (no listening).
export function estimateTime(at) {
  const list = anchorList();
  return list.length ? Math.max(0, timeAt(at, list)) : cur.book.duration * at / cur.text.text.length;
}
export async function jumpToFigure(i) {
  const mine = cur, f = mine && mine.meta.figures[i];
  if (!f) return;
  const say = (msg) => { $('viewStatus').textContent = msg; $('figStatus').textContent = msg; };
  const t = await placeInAudio(f.at, say);
  if (t == null || cur !== mine) return;
  reached.set(i, t);          // arriving here is not "reaching" it
  seek(t);
  for (const id of ['viewDlg', 'figsDlg']) closeSheet($(id));
  toast('Moved to ' + fmt(t));
}

// ---------- figures tab ----------
// One tab for the book's own pictures and tables and for the extras PDF
// (extras.js runs the sheet). It counts the book's figures, or the extras' pages.
export function renderFigTab() {
  const n = cur ? cur.meta.figures.length : 0, pages = cur && cur.book.hasExtras ? cur.book.extrasPages || 0 : 0;
  $('figsBtn').hidden = !n && !pages;
  $('figsLabel').textContent = String(n || pages || '');
  $('figsBtn').setAttribute('aria-label', 'Figures' + (n ? ', ' + n + ' in the book' : '') + (pages ? ', ' + pages + ' pages of extras' : ''));
}
// A contents list often names sections inside the chapters too. When it
// numbers its chapters, figures are gathered under those; otherwise under
// whichever entry comes before them.
function chapterEntries() {
  const numbered = cur.meta.toc.filter((e) => chapterNumber(e.label) != null);
  return numbered.length >= 3 ? numbered : cur.meta.toc;
}
const chapterOf = (at, list) => entryAt(list, at) || entryAt(cur.meta.toc, at);
// The part of the book being listened to, as its contents entry's name: from
// the place in the text when that is known, otherwise by matching the audio
// chapter's name to the contents.
function sectionNow(list) {
  const est = cur.text ? textAt(audio.currentTime, anchorList()) : null;
  if (est != null) { const sec = chapterOf(est, list); return sec ? sec.label : null; }
  const c = chapterAt(cur.book, audio.currentTime || cur.book.position || 0);
  const match = c.count > 1 ? list.find((e) => sameChapter(c.title, e.label)) : null;
  return match ? match.label : null;
}
// Fills the list of the book's figures, gathered under their chapters.
// Returns where to scroll to: the next figure coming up, or failing that the
// chapter being listened to.
export function renderFigList() {
  const box = $('figList'), figs = cur.meta.figures, chapters = chapterEntries(), now = sectionNow(chapters);
  box.textContent = '';
  $('figStatus').textContent = '';
  const est = cur.text ? textAt(audio.currentTime, anchorList()) : null;
  let nextOne = null, listening = null, group = null, name = null;
  // Chapters inside a part are set in, under the part's name when the part has no figures itself.
  const used = [...new Set(figs.map((f) => { const sec = chapterOf(f.at, chapters); return sec ? sec.label : null; }).filter(Boolean))];
  const places = new Map(outline(used, cur.meta.toc, true).map((o, k) => [used[k], o]));
  figs.forEach((f, i) => {
    const sec = chapterOf(f.at, chapters), label = sec ? sec.label : 'Before the contents';
    if (!group || label !== name) {
      name = label;
      const place = places.get(label) || { depth: 0 };
      if (place.missing) { const part = el('section', 'exgroup partonly'), title = el('div', 'exhead'); title.append(el('span', '', place.parent)); part.append(title); box.append(part); }
      const section = el('section', place.depth ? 'exgroup sub' : 'exgroup'), head = el('div', 'exhead');
      head.append(el('span', '', label));
      if (label === now) { head.append(el('span', 'exnow', 'Listening')); section.classList.add('now'); listening = listening || section; }
      group = el('ol');
      section.append(head, group); box.append(section);
    }
    const li = el('li'), view = el('button', 'figrow'), text = el('span', 'figtext');
    text.append(el('span', 'figcap', figureName(f, i)), el('span', 'muted', f.kind === 'table' ? 'Table' : 'Picture'));
    view.append(text);
    view.addEventListener('click', () => openFigure(i));
    const go = el('button', 'round');
    go.setAttribute('aria-label', 'Go to this in the audio');
    go.append(icon('M7 5v14l11-7z'));
    go.addEventListener('click', () => jumpToFigure(i));
    li.append(view, go);
    if (est != null && nextOne == null && f.at > est) { nextOne = li; li.classList.add('upnext'); }
    group.append(li);
  });
  return nextOne || listening;
}
// The same figures as small pictures. Tables have no picture, so they show their name.
let figUrls = [];
export function renderFigGrid() {
  const grid = $('figGrid'), figs = cur.meta.figures, mine = cur;
  if (grid.childElementCount === figs.length) return;
  grid.textContent = '';
  figs.forEach((f, i) => {
    const cell = el('button', 'excell'), frame = el('span', 'exthumb', f.kind === 'table' ? 'Table' : '');
    cell.setAttribute('aria-label', figureName(f, i));
    cell.append(frame, el('span', 'muted', String(i + 1)));
    cell.addEventListener('click', () => openFigure(i));
    grid.append(cell);
    if (f.kind === 'table') return;
    stored(mine.book.id, 'img-' + f.img).then((file) => {
      if (!file || cur !== mine || !frame.isConnected) return;
      const img = el('img'), url = URL.createObjectURL(file);
      figUrls.push(url); img.alt = ''; img.loading = 'lazy'; img.src = url;
      frame.replaceChildren(img);
    });
  });
}
// Empties the list and grid when the sheet closes, and lets go of the pictures.
export function clearFigures() {
  for (const u of figUrls) URL.revokeObjectURL(u);
  figUrls = [];
  $('figList').textContent = ''; $('figGrid').textContent = '';
}
async function probe(t) {
  if (probing || queueBusy || naming || !canWork() || !cur.source || modelState === 'failed' || Date.now() < probeRest) return;
  probing = true;
  const mine = cur, b = mine.book;
  try {
    await warmModel();
    const r = await transcribeAround(mine.source, t, 12, 3, transcribe, crumb);
    const loc = findInBook(mine.text, r.words, r.split);
    if (loc && mine.text.starts.length) {
      (b.anchors = b.anchors || []).push([Math.round(t), mine.text.starts[Math.min(loc.split, mine.text.starts.length - 1)]]);
      if (b.anchors.length > 400) b.anchors.shift();
      save();
    } else {
      probeRest = Date.now() + 60000;   // nothing recognisable here (music, credits): wait before trying again
    }
  } catch (err) {
    probeRest = Date.now() + 60000;
  }
  crumb(null);
  probing = false;
  runQueue();
}

let trackLast = null, trackChecked = 0, pendingFigure = null;
// After a seek the reading hasn't "passed" anything; on closing a book, start over.
export function forgetTrackPosition() { trackLast = null; }
export function resetFigureTracking() { trackLast = null; pendingFigure = null; reached.clear(); }
const reached = new Map();    // figure index -> audio time it was announced at
export function trackFigures() {
  if (Date.now() - trackChecked < 2000) return;
  trackChecked = Date.now();
  if (!cur || !settings.figAlert || !cur.text || !cur.meta.figures.length || audio.paused) return;
  const t = audio.currentTime, list = anchorList(), est = textAt(t, list), figs = cur.meta.figures;
  const gap = list.reduce((best, a) => Math.min(best, Math.abs(a.t - t)), Infinity);
  const next = est == null ? null : figs.find((f) => f.at > est);
  const soon = !!next && (next.at - est) / pace(list, t) < 90;
  if (gap > PROBE_EVERY || (soon && gap > PROBE_NEAR)) probe(t);
  if (est == null) return;
  // Announce each figure the reading has just passed. A jump (seek, or a fresh
  // anchor correcting the estimate backwards) is not "passing".
  if (trackLast && t > trackLast.t && t - trackLast.t < 15 && est > trackLast.est) {
    figs.forEach((f, i) => {
      if (f.at <= trackLast.est || f.at > est) return;
      if (reached.has(i) && Math.abs(reached.get(i) - t) < 180) return;
      reached.set(i, t);
      reachFigure(i);
    });
  }
  trackLast = { t, est };
}
function reachFigure(i) {
  const f = cur.meta.figures[i], what = (f.kind === 'table' ? 'Table' : 'Picture') + (f.cap ? ': ' + f.cap : '');
  log('figure reached at ' + fmt(audio.currentTime) + ': ' + what.slice(0, 60));
  sound('figure');
  if (settings.figPause) pause();
  pendingFigure = i;
  showPendingFigure();
  toast(what.length > 60 ? what.slice(0, 58) + '…' : what);
}
// Opens the figure straight away if the app is on screen, otherwise the next time it is.
export function showPendingFigure() {
  if (pendingFigure == null || !cur || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) return;
  const i = pendingFigure;
  pendingFigure = null;
  openFigure(i);
}
