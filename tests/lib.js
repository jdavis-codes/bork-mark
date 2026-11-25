// Shared by the browser suites. BASE is the app's address (run.sh serves the
// repo there); FIX holds the media from make-fixtures.sh.
const path = require('path');
const playwright = require('playwright');
// BROWSER=webkit runs a suite in WebKit (Safari's engine) as an iPhone;
// run.sh points WebKit at its own copy in tests/.browsers.
const ENGINE = process.env.BROWSER || 'chromium';
const BASE = process.env.BASE || 'http://localhost:8765/';
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');
let failures = 0;

async function open({ model = false, touch = true, sw = false } = {}) {
  let browser, ctx, page;
  if (ENGINE === 'webkit') {
    // WebKit has no on-device file storage (OPFS) in a throwaway profile, like
    // Safari's private browsing, so it gets a real one in a fresh folder.
    const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/borkmark-webkit-');
    ctx = await playwright.webkit.launchPersistentContext(dir, { ...playwright.devices['iPhone 15'], serviceWorkers: sw ? 'allow' : 'block' });
    browser = { close: () => ctx.close() };
    page = ctx.pages()[0] || await ctx.newPage();
  } else {
    browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch, serviceWorkers: sw ? 'allow' : 'block' });
    page = await ctx.newPage();
  }
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) page.errors.push(m.text()); });
  // With the model blocked, WebKit reports the speech worker's library failing to import: expected.
  if (!model) page.on('pageerror', () => { page.errors = page.errors.filter((e) => e !== 'Importing a module script failed.'); });
  if (!model) await page.route(/transformers|onnxruntime|huggingface/, (r) => r.abort());   // no speech model unless asked
  page.on('dialog', (d) => d.accept());
  return { browser, ctx, page };
}
// Adds a book through the Add a book sheet and waits for the player.
async function addBook(page, audio, text) {
  await page.goto(BASE);
  if (await page.$eval('#introDlg', (d) => d.open)) { await page.click('#introSkip'); await page.waitForTimeout(300); }
  await page.click('#addBtn');
  await page.setInputFiles('#addAudio', path.join(FIX, audio));
  if (text) await page.setInputFiles('#addText', path.join(FIX, text));
  await page.click('#addGo');
  await page.waitForSelector('#player:not([hidden])');
}
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('borkmark.v1')));
const logLines = (page, re) => page.evaluate((src) => (JSON.parse(localStorage.getItem('borkmark.log')) || []).filter((l) => new RegExp(src).test(l)), re.source);
// Prints a check; failures make the suite exit non-zero.
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
}
function done(page) {
  if (page) check('no page errors', !page.errors.length, page.errors.join(' | '));
  process.exitCode = failures ? 1 : 0;
}
module.exports = { ENGINE, BASE, FIX, OUT, open, addBook, saved, logLines, check, done };
