// The real speech model, end to end, about 2–3 minutes and needs the network
// (the model downloads from the CDN and Hugging Face the first time):
//   1. bookmarking a spoken book finds the right quote
//   2. chapters are named from the EPUB by themselves, after a bookmark made
//      straight away has its quote, and not again on reopening
//   3. a naming run cut short carries on from the next chapter
const { BASE, open, addBook, saved, logLines, check, done } = require('./lib');

const settled = (page) => page.waitForFunction(() => !JSON.parse(localStorage.getItem('borkmark.v1')).books[0].marks.some((m) => m.status === 'pending' || m.status === 'working'), null, { timeout: 120000 });
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
  // From a search result: bookmark it, then play from it.
  await page.click('#playBtn');   // pause
  await page.click('#searchBtn'); await page.keyboard.type('chopped corn'); await page.waitForTimeout(500);
  await page.click('#searchResults .hit .acts button[aria-label="Bookmark this"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('borkmark.v1')).books[0].marks.length === 2, null, { timeout: 120000 });
  m = (await saved(page)).books[0].marks[0];
  check('bookmark from search quotes that text', m.status === 'done' && /chopped corn/.test(m.after), (m.after || '').slice(0, 40));
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
})();
