// Lines of text too long to fit, which slide back and forth.

import { calm, el } from './dom.js';

// Text that is too long for its line slides back and forth so it can be
// read. `node` is the fixed-width line; its text lives in an inner span.
export function setScroll(node, text) {
  if (node.dataset.text === text) return;      // unchanged: leave any animation running
  node.dataset.text = text;
  let inner = node.firstElementChild;
  if (!inner || !inner.classList.contains('mq')) { inner = el('span', 'mq'); node.replaceChildren(inner); }
  inner.textContent = text;
  fitScrolls([node]);
}
// How far each line's text overflows is read for all of them first, then the
// slides are set, so the browser lays the page out once rather than per line.
// The measurement is the same whether or not the line is already sliding, so a
// line whose overflow hasn't changed keeps its animation running smoothly.
function fitScrolls(nodes) {
  const over = nodes.map((node) => {
    const inner = node.firstElementChild;
    return inner && node.clientWidth ? inner.scrollWidth - node.clientWidth : null;   // null: not on screen; refitted when it is
  });
  nodes.forEach((node, k) => {
    if (over[k] == null) return;
    const inner = node.firstElementChild, on = over[k] > 6 && !calm.matches;
    if (on) {
      const shift = -over[k] + 'px', dur = Math.max(7, 5 + over[k] / 16) + 's';   // about 30 pixels a second, with pauses
      if (inner.style.getPropertyValue('--shift') !== shift) inner.style.setProperty('--shift', shift);
      if (inner.style.getPropertyValue('--dur') !== dur) inner.style.setProperty('--dur', dur);
    }
    if (node.classList.contains('scrolls') !== on) node.classList.toggle('scrolls', on);
  });
}
export const refitScrolls = () => fitScrolls(Array.from(document.querySelectorAll('.scroller')));
window.addEventListener('resize', refitScrolls);
// Re-measure whenever a line's own width changes (a cover appearing beside it,
// a screen sliding in), so the slide distance is never based on a stale width.
if (window.ResizeObserver) {
  const watcher = new ResizeObserver((entries) => fitScrolls(entries.map((e) => e.target)));
  document.querySelectorAll('.scroller').forEach((n) => watcher.observe(n));
}
