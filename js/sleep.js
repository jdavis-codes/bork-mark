// The sleep timer.

import { log } from './log.js';
import { chapterAt, cur, pause } from './player.js';
import { $, audio, el, fmt, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';

// Either a clock time to stop at, or a position in the book (end of chapter).
export let sleep = null, sleepTick = null;
export function setSleep(next) {
  sleep = next;
  clearInterval(sleepTick);
  if (sleep) sleepTick = setInterval(checkSleep, 1000);
  renderSleep();
}
export function checkSleep() {
  if (!sleep || !cur) return;
  const due = sleep.at ? Date.now() >= sleep.at : audio.currentTime >= sleep.end - 0.4;
  if (!due) { renderSleep(); return; }
  log('sleep timer: pausing');
  setSleep(null);
  if (!audio.paused) { pause(); toast('Sleep timer: paused'); }
}
function renderSleep() {
  const label = !sleep ? '' : sleep.at ? fmt(Math.max(0, (sleep.at - Date.now()) / 1000)) : 'chapter';
  $('sleepLabel').textContent = label;
  $('sleepBtn').classList.toggle('on', !!sleep);
  $('sleepBtn').setAttribute('aria-label', sleep ? 'Sleep timer, ' + (sleep.at ? label + ' left' : 'end of chapter') : 'Sleep timer');
}
$('sleepBtn').addEventListener('click', () => {
  const ol = $('sleepList');
  ol.textContent = '';
  const add = (text, value, current) => {
    const btn = el('button');
    btn.append(el('span', '', text));
    if (current) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      setSleep(value);
      if (value) log('sleep timer: ' + text);
      closeSheet($('sleepDlg'));
    });
    const li = el('li'); li.append(btn); ol.append(li);
  };
  add('Off', null, !sleep);
  for (const m of [5, 10, 15, 30, 45, 60]) add(m + ' minutes', { at: Date.now() + m * 60000, mins: m }, !!sleep && sleep.mins === m);
  const c = chapterAt(cur.book, audio.currentTime);
  add(c.count > 1 ? 'End of chapter' : 'End of book', { end: c.end }, !!sleep && sleep.end != null);
  $('sleepDlg').showModal();
});
$('sleepClose').addEventListener('click', () => closeSheet($('sleepDlg')));
