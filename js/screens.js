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

// Swipe down on the player to return to the library. The player stays solid
// and slides down with the finger, uncovering the library, which fades in
// underneath. Past a third of the screen, or with a quick flick, it goes
// back; otherwise it settles. The scrubber and other sliders are left alone.
{
  const player = $('player'), under = [$('library'), $('libFoot')];
  // Put the library behind the player (or take it away again) for the drag.
  // While uncovered it fades with the drag, on its own compositor layer.
  const uncover = (on) => {
    for (const n of under) { n.hidden = !on; n.style.opacity = on ? '0' : ''; n.style.willChange = on ? 'opacity' : ''; }
    if (on) renderLibrary();
    renderMini();
  };
  const cover = $('cover');
  // The rest of the player fades as the cover travels, so the cover doesn't
  // slide across the title and controls: the parts are collected when a drag starts.
  let rest = [];
  const fadeRest = (o, transition) => { for (const n of rest) { n.style.transition = transition || ''; n.style.opacity = o; } };
  const clear = () => {
    player.style.transition = ''; player.style.transform = ''; player.classList.remove('lifted');
    cover.style.transition = ''; cover.style.transform = ''; cover.style.willChange = '';
    for (const n of rest) { n.style.transition = ''; n.style.opacity = ''; n.style.willChange = ''; }
    rest = [];
  };
  // While the player is pulled down, its cover shrinks and slides toward the
  // mini player's cover, arriving as the library comes into view (at REACH of
  // the screen's height), so it looks like the one turning into the other.
  // Both are measured once when the drag starts; each move is a transform.
  const REACH = 0.5;
  let path = null;   // { dx, dy0, s } from the cover's place to the mini cover's, or null
  const coverAt = (dy, p) => {
    if (!path) return '';
    p = Math.max(0, Math.min(1, p));
    // dy0 is measured with the player at rest; the player itself has moved down by dy
    return 'translate(' + (path.dx * p) + 'px, ' + ((path.dy0 - dy) * p) + 'px) scale(' + (1 + (path.s - 1) * p) + ')';
  };
  const plot = () => {
    path = null;
    const mini = $('miniCover');
    if (calm.matches || mini.hidden || $('mini').hidden) return;
    const a = cover.getBoundingClientRect(), b = mini.getBoundingClientRect();
    if (!a.width || !b.width) return;
    path = { dx: (b.left + b.width / 2) - (a.left + a.width / 2), dy0: (b.top + b.height / 2) - (a.top + a.height / 2), s: b.width / a.width };
    cover.style.willChange = 'transform';
    rest = [...player.children].filter((n) => !n.contains(cover) && !n.hidden);
    for (const n of rest) n.style.willChange = 'opacity';
  };
  const settle = () => {
    player.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.85, 0.25, 1)';
    player.style.transform = '';
    cover.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.85, 0.25, 1)';
    cover.style.transform = '';
    fadeRest('1', 'opacity 0.2s');
    for (const n of under) { n.style.transition = 'opacity 0.2s'; n.style.opacity = '0'; }
    setTimeout(() => {
      clear();
      for (const n of under) n.style.transition = '';
      if (!player.hidden) uncover(false);     // still on the player: hide the library again
    }, 240);
  };
  swipeDown(player, {
    slop: 10,
    canStart: (e) => window.scrollY <= 0 && !e.target.closest('input, select, textarea'),
    start() { player.style.transition = 'none'; cover.style.transition = 'none'; player.classList.add('lifted'); uncover(true); plot(); },
    move(dy) {
      player.style.transform = 'translateY(' + dy + 'px)';
      if (path) {
        const p = dy / (window.innerHeight * REACH);
        cover.style.transform = coverAt(dy, p);
        fadeRest(String(Math.max(0, 1 - p * 1.6)));
      }
      const shown = String(Math.min(1, dy / (window.innerHeight * 0.45)));
      for (const n of under) n.style.opacity = shown;
    },
    end(dy, speed, ended) {
      if (!(ended && (dy > window.innerHeight / 3 || (speed > 0.5 && dy > 40)))) { settle(); return; }
      // From where it was let go, the player carries on gliding down and
      // fades away, while the library finishes fading in.
      const finish = () => {
        clear(); player.style.opacity = '';
        for (const n of under) { n.style.transition = ''; n.style.opacity = ''; n.style.willChange = ''; }
        showLibrary();
      };
      if (calm.matches) { finish(); return; }
      player.style.transition = 'transform 0.3s cubic-bezier(0.3, 0.7, 0.3, 1), opacity 0.3s ease-in';
      const to = Math.max(dy + 160, window.innerHeight * 0.75);
      player.style.transform = 'translateY(' + to + 'px)';
      if (path) { cover.style.transition = 'transform 0.3s cubic-bezier(0.3, 0.7, 0.3, 1)'; cover.style.transform = coverAt(to, 1); }   // lands on the mini cover as the player fades
      player.style.opacity = '0';
      for (const n of under) { n.style.transition = 'opacity 0.25s'; n.style.opacity = '1'; }
      setTimeout(finish, 310);
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
