// Small helpers every screen uses: finding and making elements, writes that skip unchanged
// values, icons, toasts and time formatting.

export const $ = (id) => document.getElementById(id);
export const audio = $('audio');

// ---------- small helpers ----------
export const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
// Writes that skip the DOM when nothing changed. The player redraws on every
// timeupdate; untouched text and attributes cost no style or layout work.
export const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
export const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
// Progress fills are scaled, not resized: see .bar > div in the stylesheet.
export const setFill = (node, frac) => {
  const v = 'scaleX(' + Math.max(0, Math.min(1, frac || 0)).toFixed(4) + ')';
  if (node.style.transform !== v) node.style.transform = v;
};
// A tab in the player's bar is always there, so the bar never shifts as a
// book loads. One that can't be used yet (or for this book) is greyed out,
// and tapping it shows `hint` instead (see the tab bar's click guard in
// player.js). An empty hint makes it usable.
export function tabState(btn, hint) {
  btn.hidden = false;
  btn.classList.toggle('off', !!hint);
  if (hint) { btn.dataset.hint = hint; btn.setAttribute('aria-disabled', 'true'); } else { delete btn.dataset.hint; btn.removeAttribute('aria-disabled'); }
}
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
// Sheets animate out before they close. Tapping the dimmed area behind one,
// or pressing Escape, closes it the same way.
export const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

let toastTimer = null;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  // Shown as a popover so it sits above any open sheet rather than behind it.
  if (t.showPopover) { try { t.hidePopover(); } catch (e) {} try { t.showPopover(); } catch (e) {} }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { if (!t.classList.contains('show') && t.hidePopover) { try { t.hidePopover(); } catch (e) {} } }, 250);
  }, 2200);
}
// iOS only shows a button's pressed look if the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true });
export function icon(d, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); svg.append(path);
  return svg;
}

// The filled part of every slider follows its value.
export function fillRange(input) {
  const min = Number(input.min), max = Number(input.max);
  const f = String(max > min ? +((Number(input.value) - min) / (max - min)).toFixed(4) : 0);
  if (input.style.getPropertyValue('--f') !== f) input.style.setProperty('--f', f);
}
document.addEventListener('input', (e) => { if (e.target.type === 'range') fillRange(e.target); });
