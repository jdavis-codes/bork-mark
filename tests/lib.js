// Shared by the browser suites. BASE is the app's address (run.sh serves the
// repo there); FIX holds the media from make-fixtures.sh.
const path = require('path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8765/';
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');
let failures = 0;

async function open({ model = false, touch = true, sw = false } = {}) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch, serviceWorkers: sw ? 'allow' : 'block' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) page.errors.push(m.text()); });
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
module.exports = { BASE, FIX, OUT, open, addBook, saved, logLines, check, done };
