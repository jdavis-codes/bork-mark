// Moving between the library and the player: the animated change of screen, the swipe
// down from the player, and the mini player.

import { renderLibrary } from './library.js';
import { log } from './log.js';
import { addMark } from './marks.js';
import { chapterAt, cur, pause, play } from './player.js';
import { $, audio, calm, fmt, setFill, setText } from './ui/dom.js';
import { refitScrolls, setScroll } from './ui/marquee.js';
import { swipeDown } from './ui/sheets.js';

// Animates a change of screen. The browser takes a picture before and after
// `update` and blends them; elements that share a name in both pictures (the
// cover, the bottom bar) glide from their old place and size to the new one.
// `fromCover` is a library thumbnail to treat as the cover for this change.
export function morph(update, fromCover) {
  if (!document.startViewTransition || calm.matches) return update();
  const mini = $('miniCover');
  if (fromCover) { fromCover.style.viewTransitionName = 'cover'; mini.style.viewTransitionName = 'none'; }
  const reset = () => { if (fromCover) fromCover.style.viewTransitionName = ''; mini.style.viewTransitionName = ''; };
  let t;
  try { t = document.startViewTransition(async () => { await update(); reset(); }); } catch (e) { reset(); return update(); }
  t.ready.catch((e) => log('screen animation skipped: ' + ((e && e.message) || e)));
  t.finished.catch(() => {}).then(reset);
}

// The two screens. Going to the library leaves the book loaded and playing,
// with a mini player along the bottom.
export function showPlayer() {
  $('library').hidden = true; $('player').hidden = false;
  $('tabbar').hidden = false; $('libFoot').hidden = true;
  document.body.classList.add('has-bar'); document.documentElement.classList.add('has-bar');
  renderMini();
  window.scrollTo(0, 0);
  refitScrolls();
}
export function showLibrary() {
  $('player').hidden = true; $('library').hidden = false;
  $('tabbar').hidden = true; $('libFoot').hidden = false;
  document.body.classList.remove('has-bar'); document.documentElement.classList.remove('has-bar');
  renderLibrary(); renderMini();
  window.scrollTo(0, 0);
  refitScrolls();
}
$('backBtn').addEventListener('click', () => morph(showLibrary));

// Swipe down on the player to return to the library, as the big player
// turning into the mini player. The sheet's top follows the finger, down to
// the mini player's top; the cover and title travel to their places in the
// mini player, holding their height at first and dropping in as the sheet
// arrives; the rest of the player fades, and the library fades in behind.
// When the sheet's top reaches the mini player's, the change is made, whether
// or not the finger has stopped. Let go early: past ARRIVE of the way, or with
// a flick, it glides the rest of the way; otherwise it springs back. The
// scrubber and other sliders are left alone. Everything is measured once when
// a drag starts; each move only changes transforms and opacity.
{
  const player = $('player'), under = [$('library'), $('libFoot')], cover = $('cover'), title = $('title');
  const ARRIVE = 0.4;
  // Put the library behind the player (or take it away again) for the drag.
  // While uncovered it fades with the drag, on its own compositor layer.
  const uncover = (on) => {
    for (const n of under) { n.hidden = !on; n.style.opacity = on ? '0' : ''; n.style.willChange = on ? 'opacity' : ''; }
    if (on) renderLibrary();
    renderMini();
  };
  let drag = null;   // { end, cover, title, rest, mini } while a drag is under way
  const ease = (p) => p * p;   // vertical travel: slow to leave, quick to land

  // How one element gets from its place to its place in the mini player.
  // The anchor is the point that travels: the middle of the cover, the left
  // edge of the title's text (centred in its line, unless it is sliding).
  function route(el, target, origin) {
    const a = el.getBoundingClientRect(), b = target.getBoundingClientRect();
    if (!a.width || !b.width) return null;
    if (origin === 'centre') {
      return { el, origin, x0: a.left + a.width / 2, y0: a.top + a.height / 2, x1: b.left + b.width / 2, y1: b.top + b.height / 2, s: b.width / a.width,
        hw: a.width / 2, hh: a.height / 2, top1: b.top, right1: b.right };
    }
    // Where the text itself sits (centred in its line, or not), measured.
    const text = (n) => { const r = document.createRange(); r.selectNodeContents(n.querySelector('.mq') || n); return r.getBoundingClientRect(); };
    const fs = (n) => parseFloat(getComputedStyle(n).fontSize);
    const ta = text(el), tb = text(target);
    if (!ta.width || !tb.width) return null;
    return { el, origin, x0: a.left, inset: ta.left - a.left, y0: ta.top + ta.height / 2, x1: tb.left, y1: tb.top + tb.height / 2, s: fs(target) / fs(el),
      hh: ta.height / 2, top1: tb.top };
  }
  // The transform putting r's anchor p of the way along, with the sheet moved
  // down by dy. Its height eases (holding back, then dropping in), but its top
  // edge never rises above where it will sit below the mini player's top, so
  // it stays on the sheet and rides the sheet's edge into place. The title,
  // given the cover as drawn now (beside), stays under it as in the full
  // player, then swings up beside it at the end, as in the mini player.
  function along(r, p, dy, beside = null) {
    const e = ease(p), sc = 1 + (r.s - 1) * p;
    const lowest = dy + (r.top1 - drag.end) + r.hh * sc;            // highest its middle may be
    const y = Math.max(r.y0 + (r.y1 - r.y0) * e, lowest) - (r.y0 + dy);
    if (r.origin === 'centre') {
      const x = (r.x1 - r.x0) * p;
      r.middle = r.y0 + dy + y; r.bottom = r.middle + r.hh * sc; r.right = r.x0 + x + r.hw * sc;   // for the title beside it
      return 'translate(' + x + 'px, ' + y + 'px) scale(' + sc + ')';
    }
    let textX = r.x0 + r.inset + (r.x1 - r.x0 - r.inset) * p;          // where the text's left edge should be
    if (beside) {
      // w: how far it has swung from under the cover to beside it; as it does,
      // it moves clear of the cover's right edge by the mini player's gap
      const under = beside.bottom + r.below * sc, level = beside.middle + (r.y1 - beside.y1), w = p * p * p;
      textX += w * Math.max(0, beside.right + r.gap - textX);
      return 'translate(' + (textX - r.x0 - r.inset * sc) + 'px, ' + (under * (1 - w) + level * w - (r.y0 + dy)) + 'px) scale(' + sc + ')';
    }
    return 'translate(' + (textX - r.x0 - r.inset * sc) + 'px, ' + y + 'px) scale(' + sc + ')';
  }
  function show(p, dy) {
    player.style.transform = 'translateY(' + dy + 'px)';
    if (drag.cover) drag.cover.el.style.transform = along(drag.cover, p, dy);
    if (drag.title) drag.title.el.style.transform = along(drag.title, p, dy, drag.cover);
    for (const n of drag.rest) n.style.opacity = String(Math.max(0, 1 - p * 1.8));
    for (const n of under) n.style.opacity = String(Math.min(1, p * 1.2));
  }
  function begin() {
    player.style.transition = 'none';
    player.classList.add('lifted');
    uncover(true);
    const mini = $('mini'), miniCover = $('miniCover'), miniTitle = $('miniTitle');
    // Long titles slide back and forth; both hold still for the drag, so the
    // one travels to where the other's text really is.
    for (const n of [title, miniTitle]) n.classList.add('still');
    const end = mini.hidden ? window.innerHeight * 0.75 : mini.getBoundingClientRect().top;
    drag = { end, rest: [], mini: [miniCover, miniTitle], cover: null, title: null, done: false };
    if (!calm.matches && !mini.hidden) {
      if (!miniCover.hidden) drag.cover = route(cover, miniCover, 'centre');
      drag.title = route(title, miniTitle, 'left');
    }
    if (drag.cover && drag.title) {
      drag.title.below = drag.title.y0 - (drag.cover.y0 + drag.cover.hh);   // the title's middle, below the cover at rest
      drag.title.gap = drag.title.x1 - drag.cover.right1;                   // between cover and title in the mini player
    }
    for (const r of [drag.cover, drag.title]) if (r) { r.el.style.transition = 'none'; r.el.style.transformOrigin = r.origin === 'centre' ? '' : 'left center'; r.el.style.willChange = 'transform'; }
    drag.rest = [...player.children].filter((n) => !n.contains(cover) && n !== title && !n.hidden);
    for (const n of drag.rest) { n.style.transition = 'none'; n.style.willChange = 'opacity'; }
    for (const n of drag.mini) n.style.visibility = 'hidden';   // the travelling copies take their places
  }
  function clear() {
    player.style.transition = ''; player.style.transform = ''; player.style.opacity = ''; player.classList.remove('lifted');
    for (const el of [cover, title]) { el.style.transition = ''; el.style.transform = ''; el.style.transformOrigin = ''; el.style.willChange = ''; }
    for (const n of [title, $('miniTitle')]) n.classList.remove('still');
    if (drag) {
      for (const n of drag.rest) { n.style.transition = ''; n.style.opacity = ''; n.style.willChange = ''; }
      for (const n of drag.mini) n.style.visibility = '';
    }
    drag = null;
  }
  // Transitions for gliding from where the finger left off.
  const glide = (secs, curve) => {
    const t = 'transform ' + secs + 's ' + curve;
    player.style.transition = t;
    for (const r of [drag.cover, drag.title]) if (r) r.el.style.transition = t;
    for (const n of drag.rest) n.style.transition = 'opacity ' + secs + 's';
    for (const n of under) n.style.transition = 'opacity ' + secs + 's';
  };
  // The sheet has reached the mini player: it becomes the library.
  function arrive() {
    drag.done = true;
    for (const n of drag.mini) n.style.visibility = '';
    player.style.transition = 'opacity 0.12s'; player.style.opacity = '0';
    setTimeout(() => {
      clear();
      for (const n of under) { n.style.transition = ''; n.style.opacity = ''; n.style.willChange = ''; }
      showLibrary();
    }, 130);
  }
  const settle = () => {
    glide(0.22, 'cubic-bezier(0.2, 0.85, 0.25, 1)');
    show(0, 0);
    for (const n of under) n.style.opacity = '0';
    setTimeout(() => {
      clear();
      for (const n of under) n.style.transition = '';
      if (!player.hidden) uncover(false);     // still on the player: hide the library again
    }, 240);
  };
  swipeDown(player, {
    slop: 10,
    canStart: (e) => window.scrollY <= 0 && !drag && !e.target.closest('input, select, textarea'),
    start: begin,
    move(dy) {
      if (!drag || drag.done) return;
      if (dy >= drag.end) { show(1, drag.end); arrive(); return; }
      show(dy / drag.end, dy);
    },
    end(dy, speed, ended) {
      if (!drag || drag.done) return;
      if (!(ended && (dy > drag.end * ARRIVE || (speed > 0.5 && dy > 40)))) { settle(); return; }
      if (calm.matches) { show(1, drag.end); arrive(); return; }
      drag.done = true;
      const secs = Math.max(0.16, Math.min(0.3, (drag.end - dy) / 1200));
      glide(secs, 'cubic-bezier(0.3, 0.6, 0.35, 1)');
      show(1, drag.end);
      setTimeout(() => { if (drag) { drag.done = false; arrive(); } }, secs * 1000 + 20);
    },
  });
}

// ---------- mini player (library screen) ----------
export function renderMini() {
  const show = !!cur && !$('library').hidden;
  $('mini').hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (!show) return;
  const b = cur.book, t = audio.currentTime || b.position || 0, c = chapterAt(b, t);
  setScroll($('miniTitle'), b.title);
  setText($('miniTime'), fmt(t) + (c.count > 1 ? ' · ' : ''));
  setScroll($('miniChap'), c.count > 1 ? c.title : '');
  if ($('miniCover').hidden !== !cur.coverUrl) $('miniCover').hidden = !cur.coverUrl;
  if (cur.coverUrl && $('miniCover').getAttribute('src') !== cur.coverUrl) $('miniCover').src = cur.coverUrl;
  setFill($('miniFill'), t / (b.duration || 1));
}
$('miniOpen').addEventListener('click', () => morph(showPlayer));
$('miniMark').addEventListener('click', () => addMark());
$('miniPlay').addEventListener('click', () => {
  log('screen: ' + (audio.paused ? 'play' : 'pause') + ' (mini player)');
  if (audio.paused) play(); else pause();
});
