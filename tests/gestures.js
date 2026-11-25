// Swipes with real touch events, about 15 s: a sheet springs back from a short
// swipe and closes on a long one; the player settles back, or swipes down to
// the library; a pending bookmark shows its placeholder.
const { open, addBook, check, done } = require('./lib');

(async () => {
  const { browser, ctx, page } = await open();
  await addBook(page, 'book.m4b'); await page.waitForTimeout(600);
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (x, y0, y1, steps = 12) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / steps }] }); await page.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await page.tap('#speedBtn'); await page.waitForTimeout(400);
  const top = await page.$eval('#speedDlg', (d) => d.getBoundingClientRect().top);
  await swipe(195, top + 20, top + 60, 6); await page.waitForTimeout(400);
  check('short swipe: sheet springs back', await page.$eval('#speedDlg', (d) => d.open && !d.style.transform));
  await swipe(195, top + 20, top + 400); await page.waitForTimeout(500);
  check('long swipe: sheet closes', !(await page.$eval('#speedDlg', (d) => d.open)));
  await swipe(195, 300, 360, 6); await page.waitForTimeout(400);
  check('short swipe: player stays', !(await page.$eval('#player', (n) => n.hidden)) && (await page.$eval('#library', (n) => n.hidden)));
  await swipe(195, 300, 700); await page.waitForTimeout(600);
  check('long swipe: library with mini player', !(await page.$eval('#library', (n) => n.hidden)) && (await page.$eval('#player', (n) => n.hidden)) && !(await page.$eval('#mini', (n) => n.hidden)));
  check('library styles cleaned up after the drag', (await page.$eval('#library', (n) => n.style.cssText)) === '');
  check('nothing left half way through the pull', await page.evaluate(() => !document.documentElement.classList.contains('pulling')
    && !document.documentElement.classList.contains('gliding') && !document.documentElement.style.getPropertyValue('--p')));
  // pulled most of the way and cancelled, then a short pull let go: back on the player each time, cleared
  await page.tap('#miniOpen'); await page.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 200 }] });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 200 + i * 40 }] }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await page.waitForTimeout(400);
  await swipe(195, 300, 360, 6); await page.waitForTimeout(400);
  check('a cancelled pull and a short one leave the player as it was', !(await page.$eval('#player', (n) => n.hidden))
    && await page.evaluate(() => !document.documentElement.classList.contains('pulling') && getComputedStyle(document.getElementById('cover')).transform === 'none'));
  // a second finger landing part way through a pull ends it, and pulling works after
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 200 }] });
  for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 200 + i * 40 }] }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 440, id: 0 }, { x: 300, y: 500, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(400);
  check('a second finger part way through a pull leaves nothing stuck', !(await page.$eval('#player', (n) => n.hidden))
    && await page.evaluate(() => !document.documentElement.classList.contains('pulling') && !document.documentElement.classList.contains('gliding')));
  await swipe(195, 300, 800); await page.waitForTimeout(600);
  await page.tap('#miniMark'); await page.waitForTimeout(300);
  await page.tap('#miniOpen'); await page.waitForTimeout(600);
  check('player screen locks page scrolling', await page.$eval('html', (n) => n.classList.contains('has-bar')));
  await page.tap('#marksBtn'); await page.waitForTimeout(500);
  check('pending bookmark shows a placeholder', (await page.$$('.skeleton i')).length === 3);
  done(page); await browser.close();
})();
