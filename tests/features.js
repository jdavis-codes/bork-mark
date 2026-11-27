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
  say('extras row', (await text('#infoList')).match(/Extras.*?pages\)/)[0], '| tab', await page.textContent('#figsLabel'), '| extras tile', await page.$eval('#extrasAct', (t) => (t.classList.contains('has') ? 'has' : 'missing')));
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
  await page.goto(BASE + 'tests.html'); await page.waitForTimeout(800);
  check('test page loads', /tests/.test(await page.title()));

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
  // An M4A (AAC in MP4) is read like an M4B.
  await addBook(page, 'plain.m4a'); await page.waitForTimeout(1000);
  await page.click('#playBtn'); await page.waitForTimeout(1500);
  const m4a = await page.evaluate(() => ({ title: document.getElementById('title').textContent, t: document.querySelector('audio') ? document.querySelector('audio').currentTime : -1 }));
  await page.click('#playBtn');
  check('an M4A is added with its title and plays', /Plain M4A/.test(m4a.title) && m4a.t > 0.5, m4a.title + ', ' + m4a.t.toFixed(1) + ' s');
  // Opus in an M4B: read like AAC, and its clips (how quotes are found) re-wrapped as Ogg, which must decode.
  const clip = await page.evaluate(async () => {
    const { openAudio } = await import('./js/audio/container.js');
    const file = await (await fetch('tests/fixtures/opus.m4b')).blob();
    const s = await openAudio(file);
    const c = await s.clip(12, 14);
    const buf = await new AudioContext().decodeAudioData(c.buffer);
    return { kind: s.kind, chapters: s.chapters.map((x) => x.title).join(', '), start: c.startTime, seconds: buf.duration };
  }).catch((e) => ({ error: String(e) }));
  check('an Opus M4B is read and its clips decode', clip.kind === 'Opus' && clip.chapters === 'Opus One, Opus Two' && clip.seconds > 1.5 && Math.abs(clip.start - 12) < 0.1, JSON.stringify(clip));
  await addBook(page, 'opus.m4b'); await page.waitForTimeout(1000);
  const opusTitle = await page.evaluate(() => document.getElementById('title').textContent);
  check('an Opus M4B is added with its title', /Opus Book/.test(opusTitle), opusTitle);
  // A book whose audio has no cover takes the page scan's first page as one.
  await page.goto(BASE); await page.click('#addBtn');
  await page.setInputFiles('#addAudio', FIX + '/plain.m4a'); await page.setInputFiles('#addPdf', FIX + '/extras.pdf');
  await page.click('#addGo'); await page.waitForSelector('#player:not([hidden])', { timeout: 60000 }); await page.waitForTimeout(500);
  const pdfCover = await page.evaluate(() => document.getElementById('cover').getAttribute('src'));
  check('a page scan gives a cover when the audio has none', !!pdfCover, String(pdfCover));
  // A cover picked in the add sheet is used; one picked in About this book replaces it.
  await page.goto(BASE); await page.click('#addBtn');
  await page.setInputFiles('#addAudio', FIX + '/plain.m4a'); await page.setInputFiles('#addCover', FIX + '/../../icons/icon-512.png');
  await page.click('#addGo'); await page.waitForSelector('#player:not([hidden])'); await page.waitForTimeout(500);
  const picked = await page.evaluate(() => { const c = document.getElementById('cover'); return c.getAttribute('src') && c.naturalWidth; });
  check('a cover picked when adding is shown', picked > 0, String(picked));
  await page.click('#infoBtn'); await page.waitForTimeout(300);
  const label = await page.$eval('#coverAct', (t) => (t.classList.contains('has') ? 'has' : 'missing'));
  await page.setInputFiles('#coverFile', FIX + '/../../icons/icon-180.png'); await page.waitForTimeout(1500);
  const w = await page.evaluate(() => document.getElementById('cover').naturalWidth);
  // Changing the cover touches only the cover: the book's audio is still stored.
  const kept = await page.evaluate(async () => {
    const { stored } = await import('./js/storage.js'), { cur } = await import('./js/player.js');
    const a = await stored(cur.book.id, 'audio');
    return a ? a.size : 0;
  });
  check('changing the cover keeps the book’s audio', kept > 1000, kept + ' bytes');
  await page.click('#infoClose'); await page.waitForTimeout(400); await page.click('#backBtn'); await page.waitForTimeout(900);
  const row = await page.evaluate(() => { const i = document.querySelector('#books .thumb'); return i.getAttribute('src') && i.naturalWidth; });
  check('About this book changes the cover', label === 'has' && w === 180 && row === 180, label + ', player ' + w + ', library ' + row);
  // A piece that is there opens Replace / Remove; Remove takes the cover away everywhere.
  await page.click('#books .book'); await page.waitForTimeout(800);
  await page.click('#infoBtn'); await page.waitForTimeout(400);
  // Held: the menu opens before the finger lifts, and stays once it does.
  const ct = await (await page.$('#coverAct')).boundingBox();
  await page.mouse.move(ct.x + ct.width / 2, ct.y + ct.height / 2); await page.mouse.down(); await page.waitForTimeout(650);
  const whileHeld = !!(await page.$('#menu'));
  await page.mouse.up(); await page.waitForTimeout(250);
  const afterLift = !!(await page.$('#menu'));
  check('holding a piece’s tile opens its menu before letting go', whileHeld && afterLift, 'held ' + whileHeld + ', after ' + afterLift);
  await page.click('#menu button.danger'); await page.waitForTimeout(800);
  const gone = await page.evaluate(() => ({ tile: document.getElementById('coverAct').classList.contains('has'), player: document.getElementById('cover').hasAttribute('src') }));
  await page.click('#infoClose'); await page.waitForTimeout(400); await page.click('#backBtn'); await page.waitForTimeout(900);
  const rowGone = await page.evaluate(() => document.querySelector('#books .thumb').hasAttribute('src'));
  check('a piece’s menu removes it (the cover, from player and library)', !gone.tile && !gone.player && !rowGone, JSON.stringify(gone) + ' library ' + rowGone);
  // Holding a book in the library: it can be dragged to a new place, and its menu takes it off the device.
  const hues = () => page.evaluate(() => [...document.querySelectorAll('#books .thumb')].map((i) => i.style.getPropertyValue('--hue')).join(' '));
  const rowBox = async (i) => (await page.$$('#books .book'))[i].boundingBox();
  const before = await hues(), a = await rowBox(0), b = await rowBox(1);
  await page.mouse.move(a.x + 150, a.y + 40); await page.mouse.down(); await page.waitForTimeout(650);
  const menu = !!(await page.$('#menu'));
  for (let k = 1; k <= 10; k++) { await page.mouse.move(a.x + 150, a.y + 40 + (b.y + b.height * 0.8 - a.y) * k / 10); await page.waitForTimeout(16); }
  await page.mouse.up(); await page.waitForTimeout(500);
  const after = await hues();
  check('holding a book and dragging it reorders the library', menu && after.split(' ')[1] === before.split(' ')[0] && after.split(' ')[0] === before.split(' ')[1], before + ' -> ' + after);
  const n =(await page.$$('#books .book')).length, c = await rowBox(0);
  await page.mouse.move(c.x + 150, c.y + 40); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(250);
  await page.click('#menu button'); await page.waitForTimeout(600);
  const left = (await page.$$('#books .book')).length;
  check('the hold menu takes a book off the device', left === n - 1 && !(await page.$('#menu')), n + ' -> ' + left);
  // Recently deleted: the book is there, and Restore brings it back with its audio.
  await page.click('#settingsBtn'); await page.waitForTimeout(400);
  const listed = await page.$$eval('.trashlist li', (li) => li.length);
  await page.click('#trashBookList li button.restore'); await page.waitForTimeout(400);
  const back = await page.evaluate(async () => {
    const { state } = await import('./js/state.js'), { stored } = await import('./js/storage.js');
    const a = await stored(state.books[0].id, 'audio');
    return { books: state.books.length, trash: state.trash.length, audio: a ? a.size : 0 };
  });
  check('a deleted book is restored from Recently deleted, files and all', listed >= 1 && back.books === n && back.trash === listed - 1 && back.audio > 1000, listed + ' listed, ' + JSON.stringify(back));
  // A deleted bookmark comes back to its book; anything older than ten days is gone for good at launch.
  const marks = await page.evaluate(async () => {
    const { state } = await import('./js/state.js'), { trashMark, purgeTrash, renderTrash } = await import('./js/trash.js'), { stored } = await import('./js/storage.js');
    const b = state.books.find((x) => x.marks.length) || state.books[0];
    if (!b.marks.length) b.marks.push({ id: 'm-test', t: 12, status: 'heard', transcript: 'a test bookmark', created: Date.now() });
    const m = b.marks.pop(); trashMark(b, m); renderTrash();
    document.querySelector('#trashMarkList li button.restore').click();
    const restored = b.marks.includes(m);
    // ten days on: a deleted book and its files go for good
    const old = state.books[state.books.length - 1];
    state.books.splice(state.books.indexOf(old), 1);
    state.trash.unshift({ kind: 'book', book: old, at: Date.now() - 11 * 86400000 });
    purgeTrash();
    await new Promise((r) => setTimeout(r, 500));
    return { restored, purged: !state.trash.some((x) => x.book === old), files: !!(await stored(old.id, 'audio')) };
  });
  check('a deleted bookmark is restored; after ten days a book goes for good', marks.restored && marks.purged && !marks.files, JSON.stringify(marks));
  // How long they're kept: "Until emptied" keeps an old one through a launch; a shorter time
  // shows what goes at the next launch rather than deleting it there and then.
  const keepFor = await page.evaluate(async () => {
    const { state, settings } = await import('./js/state.js'), { purgeTrash, renderTrash } = await import('./js/trash.js');
    const fake = { kind: 'mark', bookId: state.books[0].id, mark: { id: 'm-old', t: 5, status: 'heard', transcript: 'old one', created: 0 }, at: Date.now() - 40 * 86400000 };
    state.trash.unshift(fake);
    settings.trashDays = 0; purgeTrash(); const forever = state.trash.includes(fake);
    renderTrash(); const foreverText = document.querySelector('#trashMarkList li .muted').textContent;
    settings.trashDays = 30; renderTrash(); const shortText = document.querySelector('#trashMarkList li .muted').textContent;
    const stillThere = state.trash.includes(fake);
    purgeTrash(); const gone = !state.trash.includes(fake);
    settings.trashDays = 10;
    return { forever, foreverText, shortText, stillThere, gone };
  });
  check('“Keep for” is honoured: until emptied keeps, a shorter time waits for the next launch', keepFor.forever && /until emptied/.test(keepFor.foreverText) && /next opens/.test(keepFor.shortText) && keepFor.stillThere && keepFor.gone, JSON.stringify(keepFor));
  await page.click('#settingsClose');
  done(page); await browser.close();
})();
