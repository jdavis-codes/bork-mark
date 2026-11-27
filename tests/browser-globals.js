// Writes the names a browser page has as globals, for eslint's no-undef
// check (fixtures/browser-globals.json). Read from Chromium itself, so the
// list matches what the app can really use.
const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const names = await page.evaluate(() => {
    const all = new Set(['caches', 'self']);   // caches only exists on https pages
    for (let o = window; o; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => all.add(n));
    return [...all].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  });
  fs.mkdirSync(__dirname + '/fixtures', { recursive: true });
  fs.writeFileSync(__dirname + '/fixtures/browser-globals.json', JSON.stringify(Object.fromEntries(names.map((n) => [n, 'readonly']))));
  await browser.close();
})();
