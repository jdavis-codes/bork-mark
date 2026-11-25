// The crash guard, about 10 s: after iOS ends the app mid-step, the next
// launch says what was going on, a bookmark that was being worked on is not
// retried by itself, and a crash while loading the model doesn't load it again.
const { BASE, open, check, done } = require('./lib');

(async () => {
  const { browser, page } = await open({ touch: false });
  for (const stage of ['loading the speech model', 'transcribing', 'naming chapters: transcribing']) {
    await page.goto(BASE + 'buttons.html');
    await page.evaluate((stage) => {
      localStorage.clear();
      localStorage.setItem('borkmark.v1', JSON.stringify({ introSeen: true, books: [{ id: 'x', title: 'T', duration: 60, audioName: 'a.m4b', autoNaming: 1,
        chapters: [{ start: 0, title: 'a' }, { start: 30, title: 'b' }], marks: [{ id: 'm', t: 5, status: 'working', created: 1 }] }] }));
      localStorage.setItem('borkmark.crumb', JSON.stringify({ stage, t: Date.now(), playing: true }));
    }, stage);
    await page.goto(BASE); await page.waitForTimeout(800);
    const r = await page.evaluate(() => ({ note: document.getElementById('crashNote').hidden ? '' : document.getElementById('crashText').textContent,
      book: JSON.parse(localStorage.getItem('borkmark.v1')).books[0], log: (JSON.parse(localStorage.getItem('borkmark.log')) || []).slice(-3).join() }));
    check(stage + ': note names the step', r.note.includes(stage));
    check(stage + ': interrupted bookmark becomes Retry', r.book.marks[0].status === 'error');
    if (stage === 'loading the speech model') check(stage + ': model not loaded again', !/loading the speech model/.test(r.log));
    if (stage.startsWith('naming')) check(stage + ': automatic naming switched off', r.book.autoNaming === 'done');
  }
  // Leaving normally mid-step is not a crash.
  await page.evaluate(() => localStorage.setItem('borkmark.crumb', JSON.stringify({ stage: 'transcribing', t: 1 })));
  await page.goto(BASE + 'buttons.html');
  check('leaving the page clears the step note', await page.evaluate(() => localStorage.getItem('borkmark.crumb') === null));
  done(page); await browser.close();
})();
