// A wide sweep, about 40 s, printed as plain lines so two versions can be
// compared (run.sh compare <git ref>): the intro, adding a book from an EPUB
// with a picture and a table, figures and the viewer, About this book (edit
// the title, chapters, a link), speed, sleep timer, chapters, skipping,
// settings and citations, reopening, bookmarking, removing the book, the
// service worker and the alignment test page.
const { BASE, FIX, open, addBook, check, done } = require('./lib');

(async () => {
  const { browser, page } = await open({ sw: true });
  const say = (...a) => console.log('  dump ' + a.join(' '));
  const text = async (sel) => (await page.innerText(sel)).replace(/\s+/g, ' ');
  await page.goto(BASE);
  for (let i = 0; i < 3; i++) await page.click('#introNext');
  say('intro', await page.textContent('#introTitle')); await page.click('#introSkip'); say('intro back', await page.textContent('#introTitle'));
  for (let i = 0; i < 3; i++) await page.click('#introNext');
  say('intro last button', await page.textContent('#introNext'));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  if (!(await page.$eval('#addDlg', (d) => d.open))) { await page.click('#addBtn'); await page.waitForTimeout(300); }
  await page.setInputFiles('#addAudio', FIX + '/book.m4b'); await page.setInputFiles('#addText', FIX + '/book.epub');
  say('picks', await page.textContent('#addAudioName'), '|', await page.textContent('#addTextName'));
  await page.click('#addGo'); await page.waitForSelector('#player:not([hidden])'); await page.waitForTimeout(1200);
  say('title', await page.$eval('#title', (n) => n.dataset.text), 'author', await page.textContent('#author'));
  say('figures tab', !(await page.$eval('#figsBtn', (n) => n.hidden)), await page.textContent('#figsLabel'));
  await page.click('#figsBtn'); await page.waitForTimeout(400);
  say('figure list', (await page.$$eval('#figList li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
  await page.click('#figList .figrow'); await page.waitForTimeout(600);
  say('viewer', await page.textContent('#viewTitle'), await page.$eval('#viewBody', (n) => n.firstElementChild && (n.firstElementChild.tagName + ' ' + n.firstElementChild.className)),
    await page.$$eval('#viewTools button', (l) => l.map((x) => x.textContent).join(',')));
  await page.click('#viewClose'); await page.waitForTimeout(300);
  await page.click('#figList li:nth-child(2) .figrow'); await page.waitForTimeout(500);
  say('table', await page.textContent('#viewTitle'), await page.$$eval('#viewBody tr', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')).join(' / ')));
  await page.click('#viewClose'); await page.waitForTimeout(300); await page.click('#figsClose'); await page.waitForTimeout(300);

  await page.click('#searchBtn'); await page.waitForTimeout(300);
  await page.keyboard.type('lazy d'); await page.waitForTimeout(500);
  say('search', await page.textContent('#searchStatus'), '|', (await page.innerText('#searchResults .hit')).replace(/\s+/g, ' '));
  // a search with enough results to scroll: the heading and field stay put
  await page.fill('#searchInput', 'the'); await page.waitForTimeout(500);
  const pinned = await page.evaluate(() => {
    const d = document.getElementById('searchDlg'), h = d.querySelector('.sheethd');
    d.scrollTop = 400;
    return { scrolled: d.scrollTop, off: Math.round(h.getBoundingClientRect().top - d.getBoundingClientRect().top) };
  });
  check('the heading and search field stay at the top while results scroll', pinned.scrolled > 0 && Math.abs(pinned.off) < 3, 'scrolled ' + pinned.scrolled + ', heading ' + pinned.off + ' px from the top');
  await page.evaluate(() => { document.getElementById('searchDlg').scrollTop = 0; });
  await page.fill('#searchInput', 'lazy d'); await page.waitForTimeout(500);
  await page.click('#searchResults .hitmain'); await page.waitForTimeout(200);
  say('search result opened', await page.$eval('#searchResults .hit', (n) => n.classList.contains('open')));
  await page.fill('#searchInput', ''); await page.waitForTimeout(400);
  say('recent searches', await page.innerText('#searchHistory'));
  await page.click('#searchClose'); await page.waitForTimeout(300);
  await page.click('#infoBtn'); await page.waitForTimeout(400);
  say('info', (await text('#infoList')).replace(/Added \S+/, 'Added (date)'));
  await page.click('#infoList .disclose'); await page.waitForTimeout(200);
  say('chapters', await text('.chapbox'));
  await page.click('#infoList dd .pencil'); await page.fill('#infoList input.inline', 'Edited Title'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  say('edited title', await page.$eval('#title', (n) => n.dataset.text));
  await (await page.$$('#infoList .filerow .pencil'))[0].click(); await page.fill('#infoList input.inline', 'libro.fm/x'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  say('link', await page.$eval('#infoList .filerow a', (a) => a.href));
  await page.click('#infoClose'); await page.waitForTimeout(300);

  await page.click('#speedBtn'); await page.waitForTimeout(300); await page.click('#speedList li:nth-child(5) button'); await page.waitForTimeout(300);
  say('speed', await page.textContent('#speedLabel'), await page.$eval('#audio', (a) => a.playbackRate), await page.textContent('#overallText'));
  await page.click('#sleepBtn'); await page.waitForTimeout(300); await page.click('#sleepList li:nth-child(2) button'); await page.waitForTimeout(300);
  say('sleep', await page.$eval('#sleepBtn', (n) => n.className));
  await page.click('#chapterBtn'); await page.waitForTimeout(300); await page.click('#chapList li:nth-child(2) button'); await page.waitForTimeout(400);
  say('chapter now', await page.$eval('#chapterText', (n) => n.dataset.text), await page.textContent('#elapsed'));
  await page.click('#forward'); await page.waitForTimeout(300); say('after forward', await page.textContent('#elapsed'));
  await page.click('#backward'); await page.waitForTimeout(300); say('after back', await page.textContent('#elapsed'));

  await page.click('#settingsBtn2'); await page.waitForTimeout(400);
  say('citation', await page.textContent('#citePreview'));
  await page.selectOption('#citeStyle', 'mla'); await page.waitForTimeout(100); say('citation mla', await page.textContent('#citePreview'));
  await page.$eval('#skipBack', (n) => { n.value = '15'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  say('skip back', await page.textContent('#skipBackOut'), await page.textContent('#backwardLabel'), await page.$eval('#skipBack', (n) => n.style.cssText));
  await page.selectOption('#capMode', 'paras'); await page.waitForTimeout(100);
  say('capture by paragraphs', await page.$eval('#capTime', (n) => n.hidden), await page.$eval('#capParas', (n) => n.hidden));
  await page.click('.swatch[data-i="1"]'); say('accent', await page.textContent('#accentOut'), await page.$eval('html', (n) => n.style.cssText));
  say('version', (await page.textContent('#appVersion')).replace(/published.*/, ''), 'switch hidden', await page.$eval('#channelRow', (n) => n.hidden));
  await page.click('#settingsClose'); await page.waitForTimeout(300);
  say('saved settings', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('borkmark.v1')).settings; return [s.skipBack, s.citeStyle, s.capture.mode, s.accent].join(','); }));

  await page.goto(BASE); await page.waitForSelector('.book'); await page.waitForTimeout(300);
  say('library', await text('#books'));
  await page.click('.book'); await page.waitForSelector('#player:not([hidden])'); await page.waitForTimeout(1200);
  say('reopened', await page.$eval('#title', (n) => n.dataset.text), await page.textContent('#speedLabel'), 'figures', await page.textContent('#figsLabel'));
  await page.click('#markBtn'); await page.waitForTimeout(300); say('bookmarks', await page.textContent('#marksLabel'));
  // Markdown: a book's text read from it, and bookmarks written out and read back.
  { const r = await page.evaluate(async () => {
      const { readBook } = await import('./js/sources/index.js'), { bookmarksMarkdown, readBookmarks, sameBook } = await import('./js/exchange.js'), { cur } = await import('./js/player.js');
      const doc = await readBook(new File(['---\ntitle: T\nauthor: A\n---\n\n# T\n\n## Part One\n\n### Chapter 1\n\nSome *plain* [words](http://x.y).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Part Two\n'], 'book.md'));
      const md = bookmarksMarkdown(cur.book), back = readBookmarks(md);
      return { doc: [doc.title, doc.author, doc.toc.map((e) => e.depth + ' ' + e.label).join(','), doc.figures.length, /Some plain words\./.test(doc.text)].join(' | '),
        marks: back.marks.length, have: cur.book.marks.length, same: sameBook(back.meta, cur.book), other: sameBook({ ...back.meta, title: 'Another book', duration: 9999 }, cur.book) }; });
    say('markdown book', r.doc);
    check('bookmarks exported to Markdown are read back, for this book only', r.marks === r.have && r.marks > 0 && r.same && !r.other, r.marks + ' of ' + r.have); }
  await page.click('#marksBtn'); await page.waitForTimeout(300); say('card', (await text('#marks')).replace(/\d+:\d\d/g, 'T'));
  await page.click('#marksClose'); await page.waitForTimeout(300);
  // Extras: add the PDF from About this book, then the sheet, a page and the page grid.
  await page.click('#infoBtn'); await page.waitForTimeout(300);
  await page.setInputFiles('#extrasFile', FIX + '/extras.pdf'); await page.waitForFunction(() => /Extras/.test(document.getElementById('infoList').innerText));
  say('extras row', (await text('#infoList')).match(/Extras.*?pages\)/)[0], '| tab', await page.textContent('#figsLabel'), '| button', await page.textContent('#extrasBtnLabel'));
  await page.click('#infoClose'); await page.waitForTimeout(300); await page.click('#figsBtn'); await page.waitForTimeout(400);
  say('figures sheet switch', (await page.$$eval('#figsView button', (l) => l.map((x) => x.textContent + (x.getAttribute('aria-pressed') === 'true' ? '*' : '')))).join(' '), '| grid button hidden', await page.$eval('#exGrid', (n) => n.hidden));
  await page.click('#exBook'); await page.waitForTimeout(200); say('book groups', (await page.$$eval('#figList .exhead', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' / '));
  await page.click('#exGrid'); await page.waitForSelector('#figGrid .exthumb img'); say('book grid', (await page.$$('#figGrid .excell')).length, 'cells', await page.$$eval('#figGrid .exthumb', (l) => l.map((x) => x.textContent || 'img').join(',')));
  await page.click('#exGrid'); await page.click('#exExtras'); await page.waitForTimeout(200);
  { const seen = await page.evaluate(() => { const d = document.getElementById('figsDlg'), h = d.querySelector('.markshead').getBoundingClientRect().bottom, n = d.querySelector('#extrasList .exgroup.now .exhead').getBoundingClientRect(); return n.top >= h - 1 && n.bottom <= d.getBoundingClientRect().bottom; });
    check('the chapter being listened to is in view below the heading', seen); }
  say('extras groups', (await page.$$eval('#extrasList .exhead', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' / '));
  say('extras rows', (await page.$$eval('.exrow', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' / '));
  await page.click('.exrow'); await page.waitForSelector('#viewBody canvas');
  say('extras page', await page.textContent('#viewTitle'), '|', await text('#viewTools'), '| previous off', await page.$eval('#viewTools button', (n) => n.disabled));
  await page.click('#viewTools button:last-child'); await page.waitForTimeout(500); say('extras next', await page.textContent('#viewTitle'), '|', await page.textContent('#viewTools .muted'));
  await page.click('#viewClose'); await page.waitForTimeout(300); await page.click('#exGrid'); await page.waitForSelector('#extrasGrid .exthumb img');
  say('extras grid', (await page.$$('#extrasGrid .excell')).length, 'cells', '| list hidden', await page.$eval('#extrasList', (n) => n.hidden));
  await page.click('#exGrid'); await page.waitForTimeout(200); say('back to the list', !(await page.$eval('#extrasList', (n) => n.hidden)), (await page.$$('.exrow')).length, 'rows'); await page.click('#figsClose'); await page.waitForTimeout(300);

  await page.click('#infoBtn'); await page.waitForTimeout(300); await page.click('#removeBtn'); await page.waitForTimeout(800);
  say('after removing', 'library shown', !(await page.$eval('#library', (n) => n.hidden)), 'books', (await page.$$('.book')).length);

  await page.waitForTimeout(1500);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); });
  check('service worker installed (every file in its list exists)', sw);
  await page.goto(BASE + 'align.html'); await page.waitForTimeout(800);
  check('alignment test page loads', /alignment/.test(await page.title()));

  // Search results in a book with long chapter titles and "page 62."-style page labels.
  await addBook(page, 'book.m4b', 'pages.epub'); await page.waitForTimeout(1000);
  await page.click('#searchBtn'); await page.keyboard.type('test'); await page.waitForTimeout(600);
  const hit = await page.$eval('#searchResults .hit', (h) => ({ page: h.querySelector('.hithead .muted').textContent,
    fits: h.querySelector('.hitmain').scrollWidth <= h.querySelector('.hitmain').clientWidth + 1
      && h.querySelector('.hitmain').getBoundingClientRect().right <= h.querySelector('.acts').getBoundingClientRect().left + 1 }));
  check('a result with a long chapter title fits beside its buttons', hit.fits);
  check('page labels read “p. 60”, not “page 60.”', hit.page === 'p. 60', hit.page);

  // An MP3 takes its title (the album), author and cover from its ID3 tag.
  await addBook(page, 'tagged.mp3'); await page.waitForTimeout(1000);
  const mp3 = await page.evaluate(() => ({ title: document.getElementById('title').textContent, cover: document.getElementById('cover').getAttribute('src') }));
  check('an MP3’s ID3 tag gives the title and cover', /Tagged Book/.test(mp3.title) && !/Track/.test(mp3.title) && !!mp3.cover, mp3.title);
  done(page); await browser.close();
})();
