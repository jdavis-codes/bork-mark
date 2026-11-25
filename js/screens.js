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

// Swipe down on the player to return to the library: the big player turns
// into the mini player. All the motion is in the stylesheet (see "pulling the
// player down" there), worked out from one number, --p: 0 is the player, 1 the
// mini player. Here a drag only measures, once, where things are going, sets
// --p as the finger moves, and lets go to 0 or 1, which the stylesheet
// animates. The sheet's top reaching the mini player's top (p = 1) makes the
// change at once; let go past ARRIVE of the way, or flick, and it glides on;
// otherwise it springs back. Every way out ends in done(), so it can't stick.
{
  const root = document.documentElement, player = $('player'), under = [$('library'), $('libFoot')];
  const ARRIVE = 0.4, GLIDE_MS = 260;
  let end = 0, state = 'idle', popFrom = 0;   // state: idle | pulling | gliding
  const set = (p) => root.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));

    // Where the cover and title go: how far each slides across, how much it
  // shrinks, and how far down it is from its place in the mini player (where
  // it stops while the sheet carries on).
  function measure() {
    const mini = $('mini'), cover = $('cover'), title = $('title'), miniCover = $('miniCover'), miniTitle = $('miniTitle');
    end = mini.hidden ? window.innerHeight * 0.75 : mini.getBoundingClientRect().top;
    const v = { '--end': end + 'px' };
    const a = cover.getBoundingClientRect(), b = miniCover.getBoundingClientRect();
    if (!miniCover.hidden && a.width && b.width) {
      v['--cover-x'] = (b.left + b.width / 2) - (a.left + a.width / 2) + 'px';
      v['--cover-stick'] = (b.top + b.height / 2) - (a.top + a.height / 2) + 'px';   // how far down until it reaches its place
      v['--cover-s'] = String(b.width / a.width);
    }
    // The title's text, centred or not, travels to the mini title's text.
    const text = (n) => { const r = document.createRange(); r.selectNodeContents(n.querySelector('.mq') || n); return r.getBoundingClientRect(); };
    const ta = text(title), tb = text(miniTitle), box = title.getBoundingClientRect();
    if (ta.width && tb.width) {
      const s = parseFloat(getComputedStyle(miniTitle).fontSize) / parseFloat(getComputedStyle(title).fontSize), inset = ta.left - box.left;
      v['--title-x'] = (tb.left - ta.left) + 'px';
      v['--title-in'] = inset * (s - 1) + 'px';                 // what scaling from the line's left edge moves the text by
      v['--title-stick'] = (tb.top + tb.height / 2) - (ta.top + ta.height / 2) + 'px';
      v['--title-s'] = String(s);
    }
    // The play button: its icon travels to the mini player's play button.
    const pa = $('playBtn').querySelector('svg').getBoundingClientRect(), pb = $('miniPlay').querySelector('svg').getBoundingClientRect();
    if (pa.width && pb.width) {
      v['--play-x'] = (pb.left + pb.width / 2) - (pa.left + pa.width / 2) + 'px';
      v['--play-stick'] = (pb.top + pb.height / 2) - (pa.top + pa.height / 2) + 'px';
      v['--play-s'] = String(pb.width / pa.width);
    }
    // The bookmark button pops out from behind it once the change is made.
    popFrom = $('miniPlay').getBoundingClientRect().left - $('miniMark').getBoundingClientRect().left;
    for (const [k, x] of Object.entries(v)) player.style.setProperty(k, x);
  }
  function done(toLibrary) {
    root.classList.remove('pulling', 'gliding');
    root.style.removeProperty('--p');
    for (const k of ['--end', '--cover-x', '--cover-stick', '--cover-s', '--title-x', '--title-in', '--title-stick', '--title-s', '--play-x', '--play-stick', '--play-s']) player.style.removeProperty(k);
    for (const n of [$('title'), $('miniTitle')]) n.classList.remove('still');
    state = 'idle';
    if (toLibrary) {
      showLibrary();
      if (!calm.matches && popFrom) {
        const mark = $('miniMark');
        mark.style.setProperty('--pop-x', popFrom + 'px');
        mark.classList.remove('pop'); void mark.offsetWidth;   // restart, if it's still popping from last time
        mark.classList.add('pop');
        mark.addEventListener('animationend', () => mark.classList.remove('pop'), { once: true });
      }
      return;
    }
    for (const n of under) n.hidden = true;   // still on the player: the library goes back out of sight
    renderMini();
  }
  function glide(to) {
    state = 'gliding';
    root.classList.add('gliding');
    // Have the transition in place before --p changes: WebKit, given both at
    // once, never starts it and the sheet stays where the finger left it.
    getComputedStyle(root).getPropertyValue('--p');
    set(to);
    setTimeout(() => done(to === 1), GLIDE_MS + 30);
  }
  swipeDown(player, {
    slop: 10,
    canStart: (e) => state === 'idle' && window.scrollY <= 0 && !e.target.closest('input, select, textarea'),
    start() {
      for (const n of under) n.hidden = false;   // the library, behind the player, to fade in
      renderLibrary(); renderMini();
      for (const n of [$('title'), $('miniTitle')]) n.classList.add('still');   // long titles hold still to be measured
      measure();
      set(0);
      root.classList.add('pulling');
      state = 'pulling';
    },
    move(dy) {
      if (state !== 'pulling') return;
      set(dy / end);
      if (dy >= end) { state = 'gliding'; done(true); }   // the sheet has reached the mini player
    },
    end(dy, speed, ended) {
      if (state !== 'pulling') return;
      if (calm.matches) { done(ended && dy > end * ARRIVE); return; }
      glide(ended && (dy > end * ARRIVE || (speed > 0.5 && dy > 40)) ? 1 : 0);
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
