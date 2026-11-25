// Bottom sheets (dialogs): closing with an animation, tapping outside to close, and the
// swipe-down gesture, which the player uses too.

import { calm } from './dom.js';

// After a touch, the button that opened a sheet should not be left with a
// focus ring once it closes; keyboard users keep their focus.
let byTouch = false;
document.addEventListener('pointerdown', () => { byTouch = true; }, true);
document.addEventListener('keydown', () => { byTouch = false; }, true);
export function closeSheet(d) {
  if (!d.open || d.classList.contains('closing') || d.classList.contains('busy')) return;
  const finish = () => {
    d.classList.remove('closing', 'dragging'); d.close();
    d.style.transform = ''; d.style.transition = '';
    if (byTouch && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  };
  if (calm.matches) { finish(); return; }
  d.classList.add('closing');
  setTimeout(finish, 200);
}
for (const d of document.querySelectorAll('dialog')) {
  const locked = () => d.classList.contains('busy');   // the add-book sheet while a book is being copied in
  d.addEventListener('cancel', (e) => { e.preventDefault(); if (!locked()) closeSheet(d); });
  d.addEventListener('click', (e) => {
    if (e.target !== d || locked()) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(d);
  });
}

// A downward swipe on `target`, shared by the sheets and the player. Once the
// finger has moved `slop` pixels, mostly downward, the gesture is ours: start()
// runs, then move(dy) for each movement, then end(dy, speed, ended) on release,
// where speed is in pixels per millisecond and `ended` is false for a cancel.
// Upward or sideways movement is left to the page (scrolling, sliders).
export function swipeDown(target, { slop, canStart, start, move, end }) {
  let g = null;
  target.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || !canStart(e)) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: e.timeStamp, dy: 0, dragging: false };
  }, { passive: true });
  target.addEventListener('touchmove', (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;            // not moved enough to tell
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { g = null; return; }   // upward or sideways: not ours
      g.dragging = true;
      start();
    }
    if (e.cancelable) e.preventDefault();
    g.dy = Math.max(0, dy);
    move(g.dy);
  }, { passive: false });
  const release = (e) => {
    const was = g;
    g = null;
    if (was && was.dragging) end(was.dy, was.dy / Math.max(1, e.timeStamp - was.at), e.type === 'touchend');
  };
  target.addEventListener('touchend', release);
  target.addEventListener('touchcancel', release);
}

// Swipe down to close a sheet. The sheet follows the finger; letting go past
// a third of the way, or with a quick flick, closes it, otherwise it springs
// back. A swipe starts from the sheet's header at any time, or from anywhere
// in the sheet once its content is scrolled to the top, so it never fights
// with scrolling a long list. Sliders and text fields are left alone.
for (const d of document.querySelectorAll('dialog.bottom, #settingsDlg')) {
  swipeDown(d, {
    slop: 8,
    canStart(e) {
      if (d.classList.contains('closing') || e.target.closest('input, select, textarea, .handle')) return false;
      const header = d.firstElementChild;
      const inHeader = (header && header.contains(e.target)) || e.touches[0].clientY - d.getBoundingClientRect().top < 48;
      return inHeader || d.scrollTop <= 0;
    },
    start() { d.style.transition = 'none'; d.classList.add('dragging'); },
    move(dy) { d.style.transform = 'translateY(' + dy + 'px)'; },
    end(dy, speed, ended) {
      const far = dy > Math.min(140, d.offsetHeight / 3);
      if (ended && (far || (speed > 0.5 && dy > 30))) { closeSheet(d); return; }
      d.style.transition = 'transform 0.2s';
      d.style.transform = '';
      setTimeout(() => { d.style.transition = ''; d.classList.remove('dragging'); }, 220);
    },
  });
}
