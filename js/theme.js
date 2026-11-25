// The accent color.

import { save, settings } from './state.js';
import { $, el } from './ui/dom.js';

// One picked color has to work as text and as a button fill on both the
// light and the dark background, so each theme gets its own adjusted shade.
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const luminance = (c) => {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Moves a color toward black or white in small steps until it reads against bg.
function readable(color, bg, toward) {
  let c = color;
  for (let i = 0; i < 24 && contrast(c, bg) < 4.5; i++) c = c.map((v, k) => v + (toward[k] - v) * 0.08);
  return c;
}
const LIGHT_BG = [246, 245, 241], DARK_BG = [21, 22, 20], INK = [17, 17, 17], PAPER = [255, 255, 255];
const PRESETS = [[null, '#16a34a', 'Green'], ['#2563eb', '#2563eb', 'Blue'], ['#7c3aed', '#7c3aed', 'Violet'],
  ['#e11d48', '#e11d48', 'Rose'], ['#ea580c', '#ea580c', 'Orange'], ['#0d9488', '#0d9488', 'Teal']];
function applyAccent() {
  const st = document.documentElement.style;
  const names = ['--accent-light', '--accent-fg-light', '--accent-dark', '--accent-fg-dark'];
  if (!/^#[0-9a-f]{6}$/i.test(settings.accent || '')) { names.forEach((n) => st.removeProperty(n)); return; }
  const base = hexToRgb(settings.accent);
  const light = readable(base, LIGHT_BG, [0, 0, 0]), dark = readable(base, DARK_BG, PAPER);
  const on = (c) => (contrast(PAPER, c) >= contrast(INK, c) ? '#ffffff' : '#111111');
  [rgbToHex(light), on(light), rgbToHex(dark), on(dark)].forEach((v, i) => st.setProperty(names[i], v));
}
export function renderSwatches() {
  const preset = PRESETS.find((p) => p[0] === (settings.accent || null));
  for (const b of document.querySelectorAll('.swatch[data-i]')) b.setAttribute('aria-pressed', String(PRESETS[b.dataset.i] === preset));
  document.querySelector('.swatch.custom').classList.toggle('on', !preset);
  $('accentOut').textContent = preset ? preset[2] : 'Custom';
  if (settings.accent) $('accentPick').value = settings.accent;
}
PRESETS.forEach(([value, shown, name], i) => {
  const b = el('button', 'swatch');
  b.type = 'button'; b.dataset.i = i; b.style.setProperty('--c', shown); b.setAttribute('aria-label', name);
  b.addEventListener('click', () => { settings.accent = value; applyAccent(); renderSwatches(); save(true); });
  $('swatches').insertBefore(b, document.querySelector('.swatch.custom'));
});
$('accentPick').addEventListener('input', (e) => { settings.accent = e.target.value; applyAccent(); renderSwatches(); });
$('accentPick').addEventListener('change', () => save(true));
applyAccent();
