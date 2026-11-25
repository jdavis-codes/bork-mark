# Bork Mark

An audiobook player that turns bookmarks into quotes. It runs entirely in the browser and is used mostly as a Home Screen app on an iPhone. The README describes the features, the file layout and deploying.

## Working on it

- No build step: plain HTML, CSS and ES modules. `app.js` starts the app, and each part lives in a module under `js/` (see the README's table). Each module opens with a line saying what it holds.
- The book text model (`js/text/`) doesn't care which file the text came from. File readers live in `js/sources/` and all return the shape described in `js/sources/index.js`. Planned: a PDF as the book text (a new reader there) and text search (on the word index in `js/text/book.js`).
- When adding a module, add it to the `SHELL` list in `sw.js`, or the app won't open offline.
- Only the module that owns a variable assigns to it. Others call a small function exported by the owner (for example `endTrim`, `setChapStatus`). eslint's `no-import-assign` enforces this.
- `stamp.sh` writes the version into `js/version.js` at deploy time. Leave its stamped `export const` lines (VERSION, CHANNEL, BUILD, COMMIT) as they are.
- Rendering: the player redraws on every `timeupdate`. Write to the DOM only when a value changes (`setText`, `setAttr`, `setFill` in `js/ui/dom.js`), and animate with `transform` and `opacity`.
- Memory: iOS ends the app without warning when it uses too much memory, and the speech model is most of it (about 340 MB at rest, 600–770 MB while loading and transcribing, measured in Chromium). Heavy steps call `crumb(stage)` so the next launch can say what happened and avoid repeating it. Keep heavy steps from overlapping.
- Logging: `log()` always records, while `detail()` records only in the dev and local copies. Users copy the log from Settings → Diagnostics.

## Branches and deploying

- `develop` publishes to `/bork-mark/dev/` and `main` to the released site. Both are published by `.github/workflows/deploy.yml`.
- The dev copy keeps its own books and settings (names prefixed `dev.`), so books added in one copy don't appear in the other.
- Push to `develop` when asked to deploy for testing. Changes reach `main` through a pull request.

## Tests

`tests/run.sh <level>` builds the test media once (ffmpeg, python3), serves the app and runs headless Chromium suites. Each check prints `ok` or `FAIL`.

| Level | What | Time |
|---|---|---|
| `lint` | eslint over `app.js` and `js/`: undefined names, writes to imports, unused code | ~5 s |
| `quick` | lint + `smoke` (add a book, play, library, bookmarks, trim, every sheet) + `gestures` (swipes) | ~1 min |
| `full` | quick + `features` (EPUB, figures, info sheet, settings, citations, reopening, removing) + `crash` (crash guard) | ~1 min |
| `speech` | the real speech model: quote found, chapters named by themselves, resuming. Needs the network | ~2 min |
| `compare <ref>` | `features` on another version and on this one, and the differences | ~1 min |

When to run what:
- Always: `lint`. It's fast and catches most mistakes after moving code.
- Small, local changes (copy, styles, one function): `lint`, plus `quick` if the change touches something on screen.
- Big changes only (moving or splitting modules, the player, sheets, gestures, storage, launch): `full`, and `compare <last commit>` for refactors that should change no behaviour.
- `speech` only when touching transcription, matching, quotes, chapter naming, the speech worker or the queue.
- None of these is an iPhone. For anything about playback, the lock screen, memory or touch feel, also ask for a check on the dev copy.
