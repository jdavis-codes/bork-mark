# Bork Mark

Bookmark audiobooks from your headphones or watch, and get the passage back as text.

Press a button while you listen and Bork Mark saves the place. It then finds the words you just heard in the book's text, so each bookmark becomes a quote you can trim, cite and share. It runs entirely in the browser: your books never leave the device.

**Open it:** https://jdavis-codes.github.io/bork-mark/

<p>
  <img src="docs/img/library.png" width="24%" alt="Library with one book and its progress">
  <img src="docs/img/player.png" width="24%" alt="Player with cover, chapter, progress and a large Bookmark button">
  <img src="docs/img/bookmarks.png" width="24%" alt="Bookmarks grouped by chapter, each with its quote">
  <img src="docs/img/trim.png" width="24%" alt="Trimming a quote by dragging handles over the text">
</p>

## Getting started

1. Open the link above in Safari on your iPhone. Tap **•••**, then **Share**, then **Add to Home Screen** (it may be under View More). This matters: Safari clears a website's saved files after about a week without a visit, and only an app on the Home Screen is exempt. Without it, your books and bookmarks can disappear.
2. Tap **Add a book** and pick the audio file (M4B or MP3). Add the EPUB too if you have it, and a PDF of the print edition if you want printed page numbers.
3. Press play. To bookmark, double- or triple-press your headphone button, press next track on a watch, or tap **Bookmark**. It works with the phone locked.
4. Open **Bookmarks** to read, trim, copy or share your quotes.

Files must be free of copy protection, such as the downloads from Libro.fm. A short guide covers the same steps the first time you open the app; Settings can show it again.

<p>
  <img src="docs/img/intro.png" width="24%" alt="Intro guide step: why and how to add the app to the Home Screen">
</p>

## What it does

| | |
|---|---|
| **Hands-free bookmarks** | The next and previous track buttons on headphones, watches and the lock screen can each bookmark, skip, or change chapter. |
| **Exact quotes** | A small speech model (Whisper, running on the phone) listens to the seconds around a bookmark, and the app finds those words in the EPUB. Without an EPUB you get what the model heard. |
| **Trimming** | Tap a sentence, drag the handles, or press and hold to cut a quote down. Ends can snap to whole sentences. |
| **Citations** | Quotes are copied and shared with a citation in a simple style, MLA, APA or Chicago, with or without the place in the audio. |
| **Page numbers** | Taken from the EPUB when it records them, or found in a PDF of the print edition. |
| **Figures** | Pictures and tables in the book text are listed, and the app can chime when the reading reaches one. |
| **Player** | Chapters, speed, sleep timer, skip buttons, a mini player, and your choice of accent colour. |

<p>
  <img src="docs/img/citations.png" width="24%" alt="Citation settings with style, audio time and a preview">
  <img src="docs/img/info.png" width="24%" alt="About this book: title, author, publisher, year and file links">
</p>

### Citations

Choose the style under Settings, Citations. The preview there shows your latest bookmark in that style.

| Style | Example |
|---|---|
| Simple | Lewis Carroll, Alice’s Adventures in Wonderland, “The Pool of Tears”, p. 21 (audiobook, 4:22) |
| MLA | Carroll, Lewis. Alice’s Adventures in Wonderland. Macmillan, 1865, p. 21. (audiobook, 4:22) |
| APA | Carroll, L. (1865). Alice’s Adventures in Wonderland (p. 21). Macmillan. (audiobook, 4:22) |
| Chicago | Lewis Carroll, Alice’s Adventures in Wonderland (Macmillan, 1865), 21. (audiobook, 4:22) |

The audio time can be turned off or reworded, for example `Libro.fm audiobook at {time}`. When a bookmark has no page number, the chapter is used instead. Citations are plain text, so titles are not italic.

Title, author, publisher and year are read from the EPUB and can be corrected under **About this book** (the ⓘ button in the player). An EPUB's date is usually that edition's, so check the year. Each file there can also carry a link, such as where you bought it.

## Good to know

- Everything is stored in the browser on your device. Removing the app from the Home Screen removes its books and bookmarks.
- The speech model is about 40 MB and is downloaded once, the first time you add a book.
- Built for Safari on iOS. It also runs in desktop Chrome and Safari.
- Quotes are found while the app is on screen. Finding them with the phone locked is an experimental setting.

## Development

There is no build step: the app is plain HTML, CSS and JavaScript modules.

```sh
python3 -m http.server 8765   # then open http://localhost:8765/
```

| File | What it holds |
|---|---|
| `index.html` | Markup and styles |
| `app.js` | The interface: library, player, bookmarks, settings |
| `align.js` | Reading M4B, MP3, EPUB and PDF files, and matching audio to text |
| `cite.js` | Citation styles |
| `align-worker.js` | The speech model, in a worker |
| `store-worker.js` | Saving files to the browser's private storage |
| `sw.js` | Service worker, so the app opens without signal |
| `buttons.html`, `align.html` | Test pages for media buttons and for alignment |

### Versions and deploying

Publishing is done by a GitHub Actions workflow, `.github/workflows/deploy.yml`. Pages must be set to deploy from Actions: Settings, Pages, Source: **GitHub Actions**.

| Branch | Goes to | Also |
|---|---|---|
| `main` | https://jdavis-codes.github.io/bork-mark/ | a git tag and a GitHub release |
| `develop` | https://jdavis-codes.github.io/bork-mark/dev/ | |

Pages serves one site per repository, so every run publishes both copies together: the latest release at the top and the head of `develop` under `dev/`. A push to `develop` republishes the latest release unchanged.

The `VERSION` file holds the first two numbers, such as `0.1`. Every push to `main` gets the next free third number (`v0.1.0`, `v0.1.1`, …) as its tag and release. To start a new series, change `VERSION` to `0.2` or `1.0`. Development builds are named after their commit, such as `0.1-dev.4989d40`. Settings, App shows which version is running.

The development copy keeps its own books and settings, separate from the released app, and installs as "Bork Mark (dev)".

The workflow runs `./stamp.sh`, which writes the version and a build number into `app.js` and `version.json`; an installed copy compares build numbers to notice a newer version.
