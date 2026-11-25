// The everyday paths, about 40 s: add a book, play, the library and mini
// player, the bookmarks list (open, trim by dragging, save, delete), and every
// sheet. Also prints layout counts during playback, to compare after
// rendering changes. Screenshots go to tests/out/.
const { BASE, OUT, open, addBook, check, done } = require('./lib');

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const { browser, ctx, page } = await open();
  await addBook(page, 'book.m4b', 'book.txt');
  await page.waitForTimeout(500);
  // Four finished bookmarks, written from another page so the app can't save over them.
  await page.goto(BASE + 'buttons.html');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('borkmark.v1'));
    s.books[0].marks = [10, 40, 90, 150].map((t, i) => ({ id: 'm' + i, t, created: Date.now() - i * 1000, status: 'done', loc: [100 + i * 200, 110 + i * 200, 125 + i * 200],
      before: 'Lead in text that goes on for a while before the point. And the sentence ', after: 'continues after the bookmark here. More text follows it.' }));
    localStorage.setItem('borkmark.v1', JSON.stringify(s));
  });
  await page.goto(BASE); await page.waitForSelector('.book'); await page.click('.book');
  await page.waitForSelector('#player:not([hidden])'); await page.waitForTimeout(800);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const measure = async (label, ms) => {
    const a = await metrics(); await page.waitForTimeout(ms); const z = await metrics();
    console.log('  info ' + label + ': ' + (z.LayoutCount - a.LayoutCount) + ' layouts, ' + (z.RecalcStyleCount - a.RecalcStyleCount) + ' style recalcs, '
      + Math.round((z.LayoutDuration - a.LayoutDuration) * 1000) + ' ms layout');
  };
  await page.click('#playBtn');
  await measure('5 s of playback', 5000);
  check('clock moves while playing', (await page.textContent('#elapsed')) !== '0:00', await page.textContent('#elapsed'));
  check('long chapter title scrolls', await page.$eval('#chapterText', (n) => n.classList.contains('scrolls')));
  await page.screenshot({ path: OUT + '/player.png' });

  await page.click('#backBtn'); await page.waitForTimeout(600);
  await measure('3 s of library with mini player', 3000);
  check('mini player shows', !(await page.$eval('#mini', (n) => n.hidden)));
  check('mini progress is a transform', /scaleX/.test(await page.$eval('#miniFill', (n) => n.style.transform)));
  await page.screenshot({ path: OUT + '/library.png' });
  await page.click('#miniOpen'); await page.waitForTimeout(600);
  await page.click('#playBtn');

  await page.click('#marksBtn'); await page.waitForTimeout(500);
  check('four cards under two chapter headings', (await page.$$('#marks .mark')).length === 4 && (await page.$$('#marks .grouphead')).length === 2);
  await page.click('#marks .mark .quote'); await page.waitForTimeout(400);
  await page.click('#marks .mark button[aria-label="Trim quote"]'); await page.waitForTimeout(600);
  const before = await page.textContent('#trimCount');
  await page.$eval('.handle.end', (n) => n.scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
  const hb = await (await page.$('.handle.end')).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + i * 4);
  await page.mouse.up(); await page.waitForTimeout(400);
  const after = await page.textContent('#trimCount');
  check('dragging the end handle widens the quote', before !== after, before + ' -> ' + after);
  await page.screenshot({ path: OUT + '/trim.png' });
  await page.click('.trimbar .primary'); await page.waitForTimeout(600);
  check('saving the trim keeps four cards', (await page.$$('#marks .mark')).length === 4);
  await page.click('#marks .mark button[aria-label="Delete bookmark"]'); await page.waitForTimeout(600);
  check('deleting leaves three, and the count follows', (await page.$$('#marks .mark')).length === 3 && (await page.textContent('#marksLabel')) === '3');
  await page.click('#marksClose'); await page.waitForTimeout(400);

  for (const [btn, close] of [['#chapterBtn', '#chapClose'], ['#speedBtn', '#speedClose'], ['#sleepBtn', '#sleepClose'], ['#infoBtn', '#infoClose'], ['#settingsBtn2', '#settingsClose']]) {
    await page.click(btn); await page.waitForTimeout(400); await page.click(close); await page.waitForTimeout(350);
  }
  check('every sheet opens and closes', (await page.$$('dialog[open]')).length === 0);
  done(page); await browser.close();
})();
