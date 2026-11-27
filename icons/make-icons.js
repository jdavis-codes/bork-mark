// Draws Borky's icons from his drawing (ART, Inkscape's units, 37.09 × 32.70):
// borky.svg (the browser tab's icon) and the Home Screen PNGs, all as white
// lines on the blue tile, and prints the heading's version (text colour lines,
// no shadows) for index.html. Run once after changing the drawing:
//   node icons/make-icons.js
const fs = require('fs');
const { chromium } = require('playwright');

const W = 37.088, H = 32.697, BLUE = '#5b8cff', PINK = '#ff96dd';
// {line} is the white, {shadow} marks the shadow shapes (dropped in the heading)
const ART = '<g transform="translate(-61.633 -193.39)" stroke-linecap="round" stroke-linejoin="round">'
  + '<path fill="{line}" transform="translate(52.13 -1.405)" d="m 28.070869,201.24522 c -0.81683,-0.21687 -1.724581,-0.25094 -2.61527,-0.005 -0.09498,0.0262 -0.234451,0.10756 -0.263701,0.2001 -0.04268,0.13504 -0.03763,0.31408 -0.03777,0.45759 -1.84e-4,0.85092 0.718358,1.54078 1.60467,1.54061 0.886074,-1.5e-4 1.604244,-0.68991 1.60406,-1.54061 -8e-6,-0.13754 -0.03781,-0.31579 -0.07584,-0.44878 -0.02537,-0.0887 -0.126203,-0.18004 -0.216148,-0.20393 z"/>'
  + '{shadow}<path fill="none" stroke="#4b4b4b" stroke-width="1.424" opacity="0.37" d="m 76.091966,198.77045 c 2.624439,-0.41796 3.073565,-0.37106 5.952151,0.19134"/>{/shadow}'
  + '<path fill="none" stroke="{line}" stroke-width="1.424" d="m 75.788707,198.51325 c 2.676437,-0.8875 3.667472,-0.87452 6.362162,0.28781"/>'
  + '<path fill="none" stroke="{line}" stroke-width="1.424" d="m 66.858991,207.32674 -1.909662,13.56333"/>'
  + '<path fill="none" stroke="{line}" stroke-width="0.5705" transform="matrix(2.3102249,0,0,2.6970604,41.705315,120.659)" d="m 12.334532,27.252007 5.486021,0.0062 2.016653,1.799922 4.557208,-0.03269 a 7.4282586,7.4282586 104.79891 0 1 -0.895786,3.390674 l -0.03343,0.06474 -7.39825,-0.03714 5.488991,2.813165"/>'
  + '{shadow}<path fill="#5c5c5c" opacity="0.64" d="m 81.913746,209.35423 7.802182,2.25829 1.306842,13.93774 -5.389614,-2.7852 -2.804916,3.32218 z"/>{/shadow}'
  + '<path fill="' + PINK + '" d="m 81.633966,208.98905 8.093751,2.55924 -0.0066,12.3837 -4.078854,-2.96862 -4.008325,2.96862 z"/>'
  + '{shadow}<path fill="#2d2d2d" stroke="#2e2e2e" stroke-width="1.424" opacity="0.3" d="m 70.263852,194.20338 -7.725317,15.10443 13.848292,0.87831 z"/>'
  + '<path fill="#2d2d2d" stroke="#2e2e2e" stroke-width="1.42" opacity="0.3" d="m 95.919655,207.93972 1.432247,-8.4066 -3.611176,2.90362 z"/>{/shadow}'
  + '<path fill="{line}" stroke="{line}" stroke-width="1.424" d="m 70.242577,194.12543 -7.897672,15.18399 11.997441,-1.945 z"/>'
  + '<path fill="{line}" stroke="{line}" stroke-width="1.42" d="m 95.934295,208.02912 1.93889,-8.98702 -3.048725,3.27641 z"/>'
  + '</g>';
const art = (line, shadows) => ART.replace(/\{shadow\}(.*?)\{\/shadow\}/g, shadows ? '$1' : '').replaceAll('{line}', line);

// Borky on a 100 × 100 tile, `size` px, the drawing `width` hundredths wide;
// `round` rounds the tile's corners (the tab icon; iOS rounds its own)
const tile = (size, width, round) => {
  const k = width / W, x = 50 - W * k / 2, y = 50 - H * k / 2 + 1;   // a touch low: the ear sits high
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"' + (size ? ' width="' + size + '" height="' + size + '"' : '') + '>'
    + '<rect width="100" height="100"' + (round ? ' rx="22"' : '') + ' fill="' + BLUE + '"/>'
    + '<g transform="translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') scale(' + k.toFixed(4) + ')">' + art('#fff', true) + '</g></svg>';
};

fs.writeFileSync(__dirname + '/borky.svg', tile(0, 80, true).replace('>', '>\n  <!-- Borky, the browser tab\'s icon. Made by make-icons.js -->\n  ') + '\n');
console.log('heading:\n<svg class="borky" viewBox="-1 -1 ' + (W + 2).toFixed(2) + ' ' + (H + 2).toFixed(2) + '" aria-hidden="true">' + art('currentColor', false) + '</svg>');

(async () => {
  const browser = await chromium.launch(), page = await browser.newPage();
  // [file, size, width of the drawing in hundredths]: maskable icons keep the drawing inside the middle 80% circle
  for (const [file, size, width] of [['icon-180.png', 180, 70], ['icon-192.png', 192, 70], ['icon-512.png', 512, 70], ['icon-maskable-512.png', 512, 58]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<body style="margin:0">' + tile(size, width, false));
    await page.screenshot({ path: __dirname + '/' + file });
  }
  await browser.close();
})();
