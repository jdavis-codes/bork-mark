// Versions: reloading, noticing and moving to a newer build, and the switch between the
// released and development copies.

import { flushLog, log } from './log.js';
import { cur } from './player.js';
import { save } from './state.js';
import { $, audio, el } from './ui/dom.js';
import { BUILD, CHANNEL, COMMIT, SOURCE, VERSION } from './version.js';

// A home-screen app has no reload button, so Settings provides one. It asks
// the service worker to look for new files first, then reloads the page.
$('appReload').addEventListener('click', async () => {
  $('appReload').disabled = true;
  log('reloading (Reload app)');
  if (cur) { cur.book.position = audio.currentTime || cur.book.position; save(true); }
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch (e) { /* offline: reload with what we have */ }
  location.reload();
});
const buildDate = (b) => new Date(Number(b) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
async function latestBuild() {
  const res = await fetch('version.json', { cache: 'no-store' });
  return String((await res.json()).build);
}
// "Version 0.1.4-dev.8 (development), commit a36ba38, published …", the
// commit linking to it on GitHub, then whether a newer build is out.
function showVersionLine(status) {
  const p = $('appVersion');
  p.replaceChildren(CHANNEL === 'local' ? 'Local copy' : 'Version ' + VERSION + (CHANNEL === 'dev' ? ' (development)' : ''));
  if (COMMIT) {
    const a = el('a', '', COMMIT.slice(0, 7));
    a.href = SOURCE + '/commit/' + COMMIT; a.target = '_blank'; a.rel = 'noopener';
    p.append(', commit ', a);
  }
  p.append(', published ' + buildDate(BUILD) + '.' + (status ? ' ' + status : ''));
}
async function showVersion() {
  showVersionLine('');
  try {
    const latest = await latestBuild();
    showVersionLine(latest === BUILD ? 'Up to date.' : 'A newer one (' + buildDate(latest) + ') is available: tap Reload app.');
  } catch (e) {
    showVersionLine('Could not check for a newer one (offline?).');
  }
}
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', showVersion);

// The released copy and the development copy are published side by side, the
// development one in dev/ inside the released site. Settings offers a switch
// to the other, showing the version that is published there now. They keep
// separate books, bookmarks and settings (see NS), so nothing carries across.
const OTHER = CHANNEL === 'release' ? { dir: 'dev/', name: 'development',
  note: 'Try new features before they are released. It keeps its own books, bookmarks and settings, so books added here are not there.' }
  : CHANNEL === 'dev' ? { dir: '../', name: 'released',
    note: 'The released version has its own books, bookmarks and settings, separate from these.' }
  : null;   // a local copy has no other version beside it
async function showChannelSwitch() {
  if (!OTHER) return;
  $('channelRow').hidden = false;
  $('channelName').textContent = 'Switch to the ' + OTHER.name + ' version';
  $('channelNote').textContent = OTHER.note;
  try {
    const res = await fetch(OTHER.dir + 'version.json', { cache: 'no-store' });
    const v = await res.json();
    $('channelVersion').textContent = 'Version ' + v.version + (v.commit ? ' (' + v.commit.slice(0, 7) + ')' : '') + ', published ' + buildDate(v.build);
  } catch (e) {
    $('channelVersion').textContent = '';   // offline: the switch still works if that copy was opened before
  }
}
for (const id of ['settingsBtn', 'settingsBtn2']) $(id).addEventListener('click', showChannelSwitch);
$('channelSwitch').addEventListener('click', () => {
  if (cur) { cur.book.position = audio.currentTime || cur.book.position; save(true); }
  flushLog();
  location.href = OTHER.dir;
});
// On launch and whenever the app comes back to the screen: if a newer build
// is published and nothing is playing or open, switch to it straight away.
// Remembering the build it reloaded for stops this from looping.
export async function autoUpdate() {
  try {
    const latest = await latestBuild();
    if (latest === BUILD || sessionStorage.getItem('borkmark.reloadedFor') === latest) return;
    if (!audio.paused || document.querySelector('dialog[open]')) return;
    sessionStorage.setItem('borkmark.reloadedFor', latest);
    log('updating to build ' + latest);
    if (cur) { cur.book.position = audio.currentTime || cur.book.position; save(true); }
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update().catch(() => {});
    location.reload();
  } catch (e) { /* offline, or storage unavailable */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoUpdate(); });
