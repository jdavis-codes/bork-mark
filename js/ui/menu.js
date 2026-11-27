// A small menu beside something on screen, over a dimmed page: the library's
// hold menu and the menus of the pieces in About this book.

import { el, icon } from './dom.js';

let open = null;   // { shade, menu, onClose }

// box: the rectangle to sit under (or over, near the bottom). items: [{ label, icon, danger, run }].
// inside: an open sheet to put it in (outside one, Safari won't let it be tapped).
// live: taps on the shade close it from the start; otherwise call the returned
// live() once the finger that opened it has let go.
export function showMenu(box, items, { inside = null, live = true, onClose = null } = {}) {
  closeMenu(true);
  const shade = el('div'), menu = el('div');
  shade.id = 'menuShade'; menu.id = 'menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    const b = el('button', it.danger ? 'danger' : '', it.label);
    b.setAttribute('role', 'menuitem');
    if (it.icon) b.prepend(icon(it.icon));
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    menu.append(b);
  }
  shade.addEventListener('click', () => closeMenu());
  (inside || document.body).append(shade, menu);
  // In a sheet both are placed within it, which scrolls; otherwise within the screen.
  let dx = 0, dy = 0;
  if (inside) {
    const r = inside.getBoundingClientRect();
    dx = -r.left; dy = inside.scrollTop - r.top;
    shade.style.position = menu.style.position = 'absolute';
    shade.style.height = inside.scrollHeight + 'px';
  }
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const below = box.bottom + 8 + h < innerHeight - 16;
  const left = Math.max(16, Math.min(box.left, innerWidth - 16 - w));
  menu.style.top = (below ? box.bottom + 8 : box.top - 8 - h) + dy + 'px';
  menu.style.left = left + dx + 'px';
  menu.style.transformOrigin = (below ? 'top ' : 'bottom ') + (left + w / 2 < box.left + box.width / 2 ? 'right' : 'left');
  if (live) shade.classList.add('live');
  addEventListener('keydown', escape);
  open = { shade, menu, onClose };
  return { live: () => shade.classList.add('live') };
}
function escape(e) { if (e.key === 'Escape') closeMenu(); }
// quiet: closed because something else takes over (a drag begins), so onClose isn't called.
export function closeMenu(quiet) {
  if (!open) return;
  const { shade, menu, onClose } = open;
  open = null;
  shade.remove(); menu.remove();
  removeEventListener('keydown', escape);
  if (!quiet && onClose) onClose();
}
export const menuOpen = () => !!open;
