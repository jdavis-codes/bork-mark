# Bork Mark

An audiobook player that turns bookmarks into quotes. It runs entirely in the browser and is used mostly as a Home Screen app on an iPhone. The README describes the features, the file layout and deploying.

## Working on it

- No build step: plain HTML, CSS and ES modules. `app.js` starts the app, and each part lives in a module under `js/` (see the README's table). Each module opens with a line saying what it holds.
- The book text model (`js/text/`) doesn't care which file the text came from. File readers live in `js/sources/` and all return the shape described in `js/sources/index.js`. Text search is `js/text/search.js` (matching) and `js/search.js` (the sheet). Planned: a PDF as the book text (a new reader there).
- Search is a way back into the audio, not a reader: a result opens only to its own paragraph. Keep it that way.
- When adding a module, add it to the `SHELL` list in `sw.js`, or the app won't open offline.
- Only the module that owns a variable assigns to it. Others call a small function exported by the owner (for example `endTrim`, `setChapStatus`). eslint's `no-import-assign` enforces this.
- `stamp.sh` writes the version into `js/version.js` at deploy time. Leave its stamped `export const` lines (VERSION, CHANNEL, BUILD, COMMIT) as they are.
- The on-screen keyboard: `fitSheet` in `js/ui/sheets.js` fits an open sheet to the visible area while the keyboard is up. Sheets with text fields rely on it.
- Rendering: the player redraws on every `timeupdate`. Write to the DOM only when a value changes (`setText`, `setAttr`, `setFill` in `js/ui/dom.js`), and animate with `transform` and `opacity`.
- Memory: iOS ends the app without warning when it uses too much memory, and the speech model is most of it (about 340 MB at rest, 600–770 MB while loading and transcribing, measured in Chromium). A small sentence model (MiniLM, in `js/meaning.js`) shares Whisper's worker for related-bookmark search; it loads only when bookmarks are searched and adds about 140 MB from then on. Heavy steps call `crumb(stage)` so the next launch can say what happened and avoid repeating it. Keep heavy steps from overlapping.
- The Figures sheet is run by `js/extras.js` (the Book | Extras switch, the grid, where it opens); `js/figures.js` fills the book's own list and grid. Chapter names from the audio, the EPUB and the extras are compared with `sameChapter` in `js/sources/extras.js`.
- Bookmarks leave and arrive as Markdown in `js/exchange.js`. Each bookmark's data rides in an HTML comment (`<!-- bork {…} -->`) under its quote; places in the text are not exported, they are found again on the importing device. `sameBook` decides whether a file is for the open book.
- Background work shows the notice in `js/ui/busy.js`: wrap a promise in `busyWhile(label, promise)`.
- Logging: `log()` always records, while `detail()` records only in the dev and local copies. Users copy the log from Settings → Diagnostics.

## Branches and deploying

- `develop` publishes to `/bork-mark/dev/` and `main` to the released site. Both are published by `.github/workflows/deploy.yml`.
- The dev copy keeps its own books and settings (names prefixed `dev.`), so books added in one copy don't appear in the other.
- Push to `develop` when asked to deploy for testing. Changes reach `main` through a pull request.

## Tests

`tests/run.sh <level>` builds the test media once (ffmpeg, python3), serves the app and runs headless Chromium and WebKit suites. Each check prints `ok` or `FAIL`.

| Level | What | Time |
|---|---|---|
| `lint` | eslint over `app.js` and `js/`: undefined names, writes to imports, unused code | ~5 s |
| `quick` | lint + `smoke` (add a book, play, library, bookmarks and their search, trim, every sheet) and `gestures` (swipes) in Chromium, then `smoke` and `keyboard` in WebKit | ~1.5 min |
| `full` | quick + `features` (EPUB, search, figures, info sheet, settings, citations, reopening, removing) in both browsers + `crash` (crash guard) | ~2 min |
| `webkit` | only the WebKit suites | ~1.5 min |
| `speech` | the real speech model: quote found, bookmark and play from search, chapters named by themselves, resuming. Needs the network | ~2.5 min |
| `compare <ref>` | `features` on another version and on this one, and the differences | ~1 min |

WebKit (Safari's engine) runs as an iPhone. `run.sh` downloads it into `tests/.browsers` the first time, along with the system libraries it needs (apt, as root), which takes a minute or two. Its tests use a real profile folder, because WebKit has no on-device file storage in a throwaway one. No test browser shows an iPhone keyboard, so `keyboard.js` simulates the way iOS reports one (a shorter visible area, scrolled down).

When to run what:
- Always: `lint`. It's fast and catches most mistakes after moving code.
- Any change to the interface: test it in WebKit too, not only Chromium (`quick` does both). iOS Safari is where the app is used, and the two differ.
- A new sheet or text field: add it to `keyboard.js`. On iOS the keyboard covers the bottom of the page and slides it up, rather than shrinking it.
- Small, local changes (copy, styles, one function): `lint`, plus `quick` if the change touches something on screen.
- Big changes only (moving or splitting modules, the player, sheets, gestures, storage, launch): `full`, and `compare <last commit>` for refactors that should change no behaviour.
- `speech` only when touching transcription, matching, quotes, chapter naming, the speech worker or the queue.
- None of these is an iPhone. For anything about playback, the lock screen, memory or touch feel, also ask for a check on the dev copy.

## Screenshots

- Playwright's `devices['iPhone 13']` page is 390 × 664: Safari with its bars. The Home Screen app, which is how the app is used, is 390 × 844. Screenshots come out at the page's size times the scale factor (780 × 1328, or 780 × 1688), not at one fixed size.
- Never resize a screenshot to a width and height written into the script. That is what stretched every contact sheet and the README pictures: 390 × 664 shots were forced into 390 × 844. Scale by one factor for both sides (`im.resize((round(w * k), round(h * k)))`, or `Image.thumbnail`), and lay a contact sheet out from each picture's own size.
- README pictures (`docs/img/`): viewport 390 × 844 at `deviceScaleFactor: 2`, saved at 0.75 of that (585 × 1266). Keep them to the few that explain the app; the README shows four in one row, each with a caption. Use public-domain sample material, not a user's own files.
