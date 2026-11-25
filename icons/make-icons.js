// Draws the Home Screen icons (PNG) from Borky's outline: light lines on the
// app's green. Run once after changing the drawing: node icons/make-icons.js
const { chromium } = require('playwright');
const PATHS = '<path d="M21.5 18 L42 1.5 L38.5 19.5 L39.5 23 L44 28.5 H61.5 Q64 28.5 64 31 V35.5 L62 41.5 H37 L48.5 47.5"/><path d="M1 22 L12.5 16.5 L18 18.5 H38.5"/><path d="M1 22.5 Q0 24 1.5 26 L10 49 L17.5 29.5"/><path d="M48.5 42 V59 L53.5 54.5 L58.5 59 V42"/>';
const icon = (size, art) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + size + '" height="' + size + '">'
  + '<rect width="100" height="100" fill="#14532d"/>'
  + '<g transform="translate(' + (50 - 32.5 * art / 65) + ' ' + (50 - 30 * art / 65) + ') scale(' + art / 65 + ')" fill="none" stroke="#f6f5f1" stroke-width="2.6" stroke-linejoin="miter" stroke-linecap="square">' + PATHS + '</g></svg>';
(async () => {
  const browser = await chromium.launch(), page = await browser.newPage();
  // [file, size, width of the drawing in hundredths]: maskable icons keep the drawing inside the middle 80% circle
  for (const [file, size, art] of [['icon-180.png', 180, 66], ['icon-192.png', 192, 66], ['icon-512.png', 512, 66], ['icon-maskable-512.png', 512, 56]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<body style="margin:0">' + icon(size, art));
    await page.screenshot({ path: __dirname + '/' + file });
  }
  await browser.close();
})();
