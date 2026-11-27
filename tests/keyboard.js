// The on-screen keyboard, about 20 s, meant for WebKit (BROWSER=webkit). No
// test browser shows an iPhone keyboard, so this one is simulated the way iOS
// reports it: the visible part of the page (visualViewport) gets shorter and
// slides down. Each sheet with a text field must then sit above the keyboard,
// with its heading and field in view.
const { open, addBook, check, done, OUT } = require('./lib');

(async () => {
  const { browser, page } = await open();
  await addBook(page, 'book.m4b', 'book.epub'); await page.waitForTimeout(1200);
  // A 336 px keyboard, with the page slid up by 120 px, as iOS does when a field near the top is focused.
  const keyboard = (up) => page.evaluate((up) => {
    const vv = window.visualViewport, page = document.documentElement.clientHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => (up ? page - 336 : page) });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => (up ? 120 : 0) });
    vv.dispatchEvent(new Event('resize'));
  }, up);
  const fits = async (sel, field) => {
    await page.waitForTimeout(150);
    return page.evaluate(([sel, field]) => {
      const vv = window.visualViewport, d = document.querySelector(sel).getBoundingClientRect(), f = document.querySelector(field).getBoundingClientRect();
      const top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
      return { ok: d.top >= top - 1 && d.bottom <= bottom + 1 && f.top >= top && f.bottom <= bottom, sheet: Math.round(d.top) + '–' + Math.round(d.bottom), seen: top + '–' + bottom };
    }, [sel, field]);
  };
  for (const [name, open, sel, field, close] of [
    ['Search book', '#searchBtn', '#searchDlg', '#searchInput', '#searchClose'],
    ['Bookmarks search', '#marksBtn', '#marksDlg', '#marksSearchInput', '#marksClose'],
    ['Settings (citation wording)', '#settingsBtn2', '#settingsDlg', '#citeTimeText', '#settingsClose'],
  ]) {
    await page.click(open); await page.waitForTimeout(400);
    if (name === 'Bookmarks search') { await page.click('#marksSearchBtn'); }
    await page.focus(field);
    await keyboard(true);
    const r = await fits(sel, field);
    check(name + ': sheet and field above the keyboard', r.ok, 'sheet ' + r.sheet + ', visible ' + r.seen);
    await page.screenshot({ path: OUT + '/keyboard-' + sel.slice(1) + '.png' });
    await keyboard(false); await page.waitForTimeout(150);
    check(name + ': back to normal when the keyboard goes', await page.$eval(sel, (d) => !d.style.maxHeight && !d.style.marginBottom));
    if (name === 'Bookmarks search') await page.click('#marksSearchCancel');
    await page.click(close); await page.waitForTimeout(350);
  }
  done(page); await browser.close();
})();
