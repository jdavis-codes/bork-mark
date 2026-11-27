// The Settings sheet.

import { formatCitation, STYLES } from './cite.js';
import { logLines } from './log.js';
import { chapterAt, cur, setMediaSession } from './player.js';
import { runQueue } from './queue.js';
import { requoteAll } from './quotes.js';
import { retuneSounds } from './sounds.js';
import { DEFAULTS, save, settings } from './state.js';
import { renderSwatches } from './theme.js';
import { renderTrash } from './trash.js';
import { $, fillRange, fmt, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';

// Each slider: element id, where its value lives, and how to show it.
const secs = (v) => v + ' s';
const paras = (v) => '+' + v;
const percent = (v) => v + '%';
const SLIDERS = [
  ['nextSecs', settings.next, 'secs', secs], ['prevSecs', settings.prev, 'secs', secs],
  ['skipBack', settings, 'skipBack', secs], ['skipFwd', settings, 'skipFwd', secs],
  ['capBefore', settings.capture, 'before', secs], ['capAfter', settings.capture, 'after', secs],
  ['parasBefore', settings.capture, 'parasBefore', paras], ['parasAfter', settings.capture, 'parasAfter', paras],
  ['soundVolume', settings, 'soundVolume', percent],
];
const isSkip = (a) => a === 'fwd' || a === 'back';
// The sound chosen for each event. Older settings had one style for all and a switch for each.
const EVENT_SOUNDS = ['soundMark', 'soundSkip', 'soundFigure'];
const soundChoice = (id) => (settings[id] === false ? 'none' : typeof settings[id] === 'string' ? settings[id] : settings.soundStyle || 'chime');
export function renderSettings() {
  renderTrash();
  for (const [id, obj, key, show] of SLIDERS) {
    const input = $(id);
    input.value = Math.max(Number(input.min), Math.min(Number(input.max), obj[key]));
    $(id + 'Out').textContent = show(Number(input.value));
    fillRange(input);
  }
  renderSwatches();
  $('nextAction').value = settings.next.action; $('prevAction').value = settings.prev.action;
  $('nextSecsField').hidden = !isSkip(settings.next.action);
  $('prevSecsField').hidden = !isSkip(settings.prev.action);
  $('capMode').value = settings.capture.mode;
  $('capTime').hidden = settings.capture.mode !== 'time';
  $('capParas').hidden = settings.capture.mode !== 'paras';
  $('lockSeek').value = settings.lockSeek ? 'skip' : 'track';
  $('bgQuotes').checked = settings.bgQuotes; $('trimSnap').checked = settings.trimSnap;
  $('trashDays').value = String(settings.trashDays);
  $('citeStyle').value = settings.citeStyle; $('citeTime').checked = settings.citeTime;
  if (document.activeElement !== $('citeTimeText')) $('citeTimeText').value = settings.citeTimeText;
  $('citeTimeField').hidden = !settings.citeTime;
  renderCitePreview();
  $('sounds').checked = settings.sounds; $('figAlert').checked = settings.figAlert; $('figPause').checked = settings.figPause;
  $('figPauseRow').hidden = !settings.figAlert;
  $('soundOptions').hidden = !settings.sounds;
  for (const id of EVENT_SOUNDS) $(id).value = soundChoice(id);
  $('backwardLabel').textContent = settings.skipBack; $('forwardLabel').textContent = settings.skipFwd;
  $('backward').setAttribute('aria-label', 'Back ' + settings.skipBack + ' seconds');
  $('forward').setAttribute('aria-label', 'Forward ' + settings.skipFwd + ' seconds');
}
// An example in the chosen style: the open book's latest bookmark if there is one.
const CITE_SAMPLE = { author: 'Henry Ford, Samuel Crowther', title: 'My Life and Work', publisher: 'Doubleday, Page & Company', year: '1922', section: 'Chapter V', page: '77', time: '2:14:09' };
function renderCitePreview() {
  const m = cur && cur.book.marks[cur.book.marks.length - 1];
  const wording = $('citeTimeText').value.trim() || DEFAULTS.citeTimeText;
  $('citePreview').textContent = m && cur.book.author
    ? formatCitation({ author: cur.book.author, title: cur.book.title, publisher: cur.book.publisher, year: cur.book.year,
      section: m.section || (chapterAt(cur.book, m.t).count > 1 ? chapterAt(cur.book, m.t).title : ''), page: m.page, time: fmt(m.t) },
    { style: $('citeStyle').value, audioTime: $('citeTime').checked, audioText: wording })
    : formatCitation(CITE_SAMPLE, { style: $('citeStyle').value, audioTime: $('citeTime').checked, audioText: wording });
}
function readSettings() {
  const was = JSON.stringify(settings.capture), heard = EVENT_SOUNDS.map(soundChoice), loud = settings.soundVolume;
  for (const [id, obj, key] of SLIDERS) obj[key] = Number($(id).value);
  settings.next.action = $('nextAction').value; settings.prev.action = $('prevAction').value;
  settings.capture.mode = $('capMode').value;
  settings.lockSeek = $('lockSeek').value === 'skip';
  settings.bgQuotes = $('bgQuotes').checked; settings.trimSnap = $('trimSnap').checked;
  settings.citeStyle = STYLES[$('citeStyle').value] ? $('citeStyle').value : 'simple';
  settings.trashDays = Number($('trashDays').value) || 0;
  settings.citeTime = $('citeTime').checked;
  settings.citeTimeText = $('citeTimeText').value.trim() || DEFAULTS.citeTimeText;
  settings.sounds = $('sounds').checked; settings.figAlert = $('figAlert').checked; settings.figPause = $('figPause').checked;
  for (const id of EVENT_SOUNDS) settings[id] = $(id).value;
  // Play the sound that was changed; after a change of loudness, the bookmark's.
  const changed = EVENT_SOUNDS.findIndex((id, k) => settings[id] !== heard[k]);
  if (settings.sounds && (changed >= 0 || settings.soundVolume !== loud)) retuneSounds(['mark', 'fwd', 'figure'][Math.max(0, changed)]);
  save(true);
  renderSettings(); setMediaSession(); runQueue();
  if (JSON.stringify(settings.capture) !== was) requoteAll();
}
$('settingsDlg').addEventListener('change', readSettings);
// Show the number while a slider is being dragged; it is saved on release.
$('settingsDlg').addEventListener('input', (e) => {
  const row = SLIDERS.find((r) => r[0] === e.target.id);
  if (row) $(row[0] + 'Out').textContent = row[3](Number(e.target.value));
  if (e.target.id === 'citeTimeText') renderCitePreview();
});
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', () => { renderSettings(); $('settingsDlg').showModal(); $('settingsDlg').scrollTop = 0; });
$('settingsClose').addEventListener('click', () => closeSheet($('settingsDlg')));
$('logCopy').addEventListener('click', async () => {
  const text = logLines.join('\n') + '\n' + navigator.userAgent;
  try { await navigator.clipboard.writeText(text); toast('Log copied'); } catch (e) { toast('Copy failed', 'warn'); }
});
