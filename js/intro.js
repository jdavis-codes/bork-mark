// The intro guide.

import { save, state } from './state.js';
import { $, el, icon, toast } from './ui/dom.js';
import { closeSheet } from './ui/sheets.js';

// Shown once to someone with an empty library; Settings can show it again.
const INTRO = [
  { art: 'M7 4h10v16l-5-4-5 4z', title: 'Bookmark without touching your phone',
    body: 'Bork Mark plays your audiobooks. Press a button on your headphones and it saves the passage you just heard, in the book’s own words. Everything stays on this device.' },
  { art: 'M12 5v14M5 12h14', title: 'Add a book',
    body: 'Pick the audio file (M4B, M4A or MP3). Add the EPUB as well to get exact quotes, and a PDF if you want the printed page numbers. Files need to be free of copy protection.' },
  { art: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z', title: 'Bookmark from anywhere',
    body: 'Double- or triple-press your headphone button, press next track on a watch, or tap Bookmark. It works with the phone locked. Settings decides what each button does.' },
  { art: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12', title: 'Trim, cite and share',
    body: 'The app listens to a few seconds around each bookmark and finds them in the text. Open Bookmarks to trim a quote to the sentences you want, then copy or share it with a citation.' },
  { art: 'M12 15V3M8 7l4-4 4 4M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8', title: 'Add it to your Home Screen', home: true,
    body: 'Safari clears a website’s saved files after about a week without a visit. An app on the Home Screen is exempt, so your books and bookmarks stay.',
    other: 'Installed, Bork Mark opens in its own window, works without a connection, and the browser is less likely to clear your books to save space.' },
];
let introAt = 0;
// Chrome, Edge and other Chromium browsers let a page offer its own install
// button: they hand over an event to keep, and the button replays it. Safari
// has nothing like it, so there the guide shows the steps instead.
let installOffer = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installOffer = e; if ($('introDlg').open) renderIntro(); });
window.addEventListener('appinstalled', () => { installOffer = null; toast('Installed'); if ($('introDlg').open) renderIntro(); });
$('introInstall').addEventListener('click', async () => {
  if (!installOffer) return;
  const offer = installOffer; installOffer = null;
  offer.prompt();
  await offer.userChoice.catch(() => {});
  renderIntro();
});
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const onIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
function renderIntro() {
  const step = INTRO[introAt], last = introAt === INTRO.length - 1;
  // The Home Screen step shows how to get there, unless that is where we are.
  const done = step.home && installed();
  $('introArt').replaceChildren(icon(done ? 'M5 12.5l4.5 4.500L19 7.500' : step.art));
  $('introTitle').textContent = done ? 'You’re all set' : step.home && !onIOS ? 'Install it to keep your books' : step.title;
  $('introBody').textContent = done ? 'Opened from here, your books and bookmarks are kept. In a browser tab, a website’s saved files can be cleared to save space.' : step.home && !onIOS ? step.other : step.body;
  const offer = !!step.home && !done && !!installOffer;
  $('introInstall').hidden = !offer;
  $('introHow').hidden = !step.home || done || offer || !onIOS;
  $('introNote').hidden = !step.home || done || offer || onIOS;
  $('introStep').classList.toggle('compact', !!step.home && !done);
  $('introArrow').hidden = !step.home || done || !onIOS;
  $('introDots').replaceChildren(...INTRO.map((_, k) => el('span', k === introAt ? 'on' : '')));
  $('introNext').textContent = last ? (state.books.length ? 'Done' : 'Add a book') : 'Next';
  $('introSkip').textContent = introAt ? 'Back' : 'Skip';
  // Restart the slide-in for the new step.
  const box = $('introStep'); box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
}
export function showIntro() { introAt = 0; renderIntro(); $('introDlg').showModal(); }
$('introNext').addEventListener('click', () => {
  if (introAt < INTRO.length - 1) { introAt++; renderIntro(); return; }
  closeSheet($('introDlg'));
  if (!state.books.length) setTimeout(() => $('addBtn').click(), 240);
});
$('introSkip').addEventListener('click', () => { if (introAt) { introAt--; renderIntro(); } else closeSheet($('introDlg')); });
$('introDlg').addEventListener('close', () => { state.introSeen = true; save(true); });
$('introShow').addEventListener('click', () => { closeSheet($('settingsDlg')); setTimeout(showIntro, 240); });
