// The real speech model, end to end, about 2–3 minutes and needs the network
// (the model downloads from the CDN and Hugging Face the first time):
//   1. bookmarking a spoken book finds the right quote
//   2. chapters are named from the EPUB by themselves, after a bookmark made
//      straight away has its quote, and not again on reopening
//   3. a naming run cut short carries on from the next chapter
//   4. bookmarks related by meaning
//   5. a long capture is quoted from its two ends
const { BASE, open, addBook, saved, logLines, check, done } = require('./lib');

const settled = (page) => page.waitForFunction(() => !JSON.parse(localStorage.getItem('borkmark.v1')).books[0].marks.some((m) => m.status === 'pending' || m.status === 'working'), null, { timeout: 120000 });
// Waits for the speech model. Leaving the page while it loads cuts the load short, which in
// WebKit shows up as page errors or a navigation that never finishes.
const modelReady = (page) => page.evaluate(() => import(new URL('js/speech.js', location.href).href).then((m) => m.warmModel()));
const named = (page, value) => page.waitForFunction((v) => JSON.parse(localStorage.getItem('borkmark.v1')).books[0].autoNaming === v, value, { timeout: 240000 });

(async () => {
  // 1. A bookmark at 0:25 of the spoken sentences.
  let { browser, page } = await open({ model: true });
  await addBook(page, 'speech.m4b', 'speech.txt');
  await page.evaluate(() => { document.getElementById('audio').currentTime = 22; });
  await page.click('#playBtn'); await page.waitForTimeout(3000);
  await page.click('#markBtn');
  await settled(page);
  let m = (await saved(page)).books[0].marks[0];
  check('quote found for a spoken bookmark', m.status === 'done' && /lemons makes fine punch/.test(m.before + m.after), m.status + ': ' + (m.after || '').slice(0, 40));
  console.log('  info ' + (await logLines(page, /ready in|transcribed/)).map((l) => l.slice(13)).join(' | '));
  // In the background the model is let go; the next quote loads it again.
  await page.click('#playBtn');   // pause
  const show = (state) => page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await show('hidden'); await page.waitForTimeout(300); await show('visible');
  check('model let go in the background', (await logLines(page, /speech model let go/)).length === 1);
  // From a search result: bookmark it, then play from it.
  await page.click('#searchBtn'); await page.keyboard.type('chopped corn'); await page.waitForTimeout(500);
  await page.click('#searchResults .hit .acts button[aria-label="Bookmark this"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('borkmark.v1')).books[0].marks.length === 2, null, { timeout: 120000 });
  m = (await saved(page)).books[0].marks[0];
  check('bookmark from search quotes that text', m.status === 'done' && /chopped corn/.test(m.after), (m.after || '').slice(0, 40));
  check('…with the model loaded again from the device', (await logLines(page, /ready in .* from the copy on this device/)).length === 1, (await logLines(page, /ready in/)).map((l) => l.slice(13)).join(' | '));
  check('…at the time it is read (about 0:22)', m.t > 16 && m.t < 30, m.t.toFixed(1));
  await page.click('#searchResults .hit .acts button[aria-label="Play from here"]');
  await page.waitForFunction(() => !document.getElementById('searchDlg').open, null, { timeout: 120000 });
  const at = await page.$eval('#audio', (a) => ({ t: a.currentTime, paused: a.paused }));
  check('play from search moves there and plays', !at.paused && at.t > 16 && at.t < 32, at.t.toFixed(1));
  done(page); await browser.close();

  // 2. Chapters named by themselves, a bookmark first.
  ({ browser, page } = await open({ model: true }));
  await addBook(page, 'chapters.m4b', 'chapters.epub');
  check('chapters start with the audio’s names', (await page.$eval('#chapterText', (n) => n.dataset.text)) === 'Track 1');
  await page.evaluate(() => { document.getElementById('audio').currentTime = 30; }); await page.waitForTimeout(300);
  await page.click('#markBtn');
  await named(page, 'done');
  const b = (await saved(page)).books[0];
  check('both chapters named from the contents', b.chapters.every((c) => c.title === 'The Harvard Sentences' && c.src === 'text'), b.chapters.map((c) => c.title).join(', '));
  check('the bookmark was quoted', b.marks[0].status === 'done');
  const order = await logLines(page, /· quote:|work: naming chapters/);
  check('bookmark quoted before any chapter was listened to', order.length > 1 && /quote:/.test(order[0]), order.map((l) => l.slice(13)).join(' | '));
  check('player shows the new name', (await page.$eval('#chapterText', (n) => n.dataset.text)) === 'The Harvard Sentences');
  await page.goto(BASE); await page.click('.book'); await page.waitForTimeout(20000);
  check('not run again on reopening', !(await logLines(page, /naming chapters from/)).slice(1).length);
  done(page); await browser.close();

  // 3. Leave after the first chapter, then come back.
  ({ browser, page } = await open({ model: true }));
  await addBook(page, 'chapters.m4b', 'chapters.epub');
  await named(page, 1);
  await page.goto(BASE + 'buttons.html');
  await page.goto(BASE); await page.click('.book');
  await named(page, 'done'); await page.waitForTimeout(1500);
  check('resumes from chapter 2', (await logLines(page, /naming chapters from the contents, from chapter 2/)).length === 1);
  done(page); await browser.close();

  // 4. Searching bookmarks finds the ones related by meaning, sharing no words.
  ({ browser, page } = await open({ model: true }));
  await addBook(page, 'book.m4b', 'book.txt');
  await modelReady(page);
  await page.goto(BASE + 'buttons.html');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('borkmark.v1'));
    s.books[0].marks = ['The birch canoe slid on the smooth planks.', 'Rice is often served in round bowls.', 'These days a chicken leg is a rare dish.',
      'The box was thrown beside the parked truck.'].map((q, i) => ({ id: 'q' + i, t: 10 + i * 20, created: i, status: 'done', loc: [100, 110, 125], before: '', after: q }));
    localStorage.setItem('borkmark.v1', JSON.stringify(s));
  });
  await page.goto(BASE); await page.click('.book'); await page.waitForTimeout(800);
  await page.click('#marksBtn'); await page.click('#marksSearchBtn');
  const related = async (q) => {
    await page.fill('#marksSearchInput', q);
    await page.waitForFunction(() => { const n = document.querySelector('#marks .related'); return n && !/Looking/.test(n.textContent); }, null, { timeout: 180000 });
    return page.$$eval('#marks .related .mark', (l) => l.map((n) => n.dataset.id).join(','));
  };
  let r = await related('boat');
  check('“boat” finds the canoe, by meaning', r === 'q0', r);
  r = await related('food');
  check('“food” finds the rice and the chicken', r.split(',').sort().join(',') === 'q1,q2', r);
  r = await related('zebra');
  check('“zebra” finds nothing', r === '', r || '(none)');
  check('each quote’s meaning is kept', (await saved(page)).books[0].marks.every((m) => m.vec && m.vec.v.length === 512));
  done(page); await browser.close();

  // 5. A long capture (two minutes) is placed from its two ends: only those
  //    are listened to, and the quote is the book's text between them.
  ({ browser, page } = await open({ model: true }));
  await addBook(page, 'long.m4b', 'long.txt');
  await modelReady(page);
  await page.goto(BASE + 'buttons.html');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('borkmark.v1'));
    s.settings.capture = { mode: 'time', before: 110, after: 15, parasBefore: 1, parasAfter: 1 };
    s.books[0].marks = [{ id: 'long', t: 125, created: 1, status: 'pending' }];
    localStorage.setItem('borkmark.v1', JSON.stringify(s));
  });
  await page.goto(BASE); await page.click('.book');
  await settled(page);
  m = (await saved(page)).books[0].marks[0];
  const quote = (m.before || '') + (m.after || '');
  check('long capture: quote found', m.status === 'done', m.status + ' ' + (m.error || ''));
  check('…from its two ends, a minute of listening', (await logLines(page, /placed from its ends, 60 s heard/)).length === 1 && (await logLines(page, /transcribed 30 s/)).length === 2,
    (await logLines(page, /quote:|transcribed/)).map((l) => l.slice(13)).join(' | '));
  check('…with the text between them, which was never heard', /pink salmon/.test(quote) && /useless trash/.test(quote), quote.length + ' characters');
  check('…starting and ending where the capture does', /^.{0,160}(chicken leg|Rice is often|juice of lemons)/.test(quote) && /(dirty face|Mend the coat|badly strained|birth to kittens)[^.]*\.?.{0,120}$/.test(quote), quote.slice(0, 50) + ' … ' + quote.slice(-50));
  check('…split at the bookmark', /(birth to kittens|no clear response|meal was cooked)/.test(m.before.slice(-60) + m.after.slice(0, 60)), m.before.slice(-40) + ' | ' + m.after.slice(0, 40));
  done(page); await browser.close();
})();
