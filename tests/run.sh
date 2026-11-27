#!/bin/sh
# Runs the checks. Usage: tests/run.sh [level]
#
#   lint     eslint over app.js and js/                                ~5 s
#   quick    lint; smoke and gestures in Chromium; smoke and the
#            keyboard in WebKit (Safari's engine)                       ~2 min
#   full     quick, then features in both, and crash                    ~3 min
#   speech   the real speech model end to end, in Chromium and WebKit
#            (needs the network)                                       ~6 min
#   all      full, then speech                                          ~9 min
#   webkit   only the WebKit suites                                      ~1.5 min
#   compare <git ref>
#            features on that version and on this one, then the differences
#
# Needs node with Playwright (and eslint for lint), ffmpeg and python3 for the
# test media, which make-fixtures.sh builds once into tests/fixtures/. WebKit
# is downloaded once into tests/.browsers, with the system libraries it needs
# (apt, as root).
set -e
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
LEVEL=${1:-quick}
PIDS=""
trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done' EXIT

serve() {   # serve <dir> <port>
  python3 -m http.server "$2" --directory "$1" >/dev/null 2>&1 &
  PIDS="$PIDS $!"
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -sf "http://localhost:$2/" >/dev/null && return; sleep 0.3; done
  echo "could not serve $1 on port $2"; exit 1
}
suite() {   # suite <name>: run tests/<name>.js in Chromium against the app on port 8765
  echo "== $1"
  BASE=http://localhost:8765/ node "$1.js"
}
webkit() {  # webkit <name>: the same in WebKit, as an iPhone
  echo "== $1 (webkit)"
  [ -n "$(ls -d .browsers/webkit-* 2>/dev/null)" ] || {
    echo "  setting up WebKit (once)"
    PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers" node "$NODE_PATH/playwright/cli.js" install webkit >/dev/null
    node "$NODE_PATH/playwright/cli.js" install-deps webkit >/dev/null
  }
  BROWSER=webkit PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers" BASE=http://localhost:8765/ node "$1.js"
}
lint() {
  echo "== lint"
  [ -f fixtures/browser-globals.json ] || node browser-globals.js
  (cd "$ROOT" && eslint --no-config-lookup -c tests/eslint.config.mjs app.js js) && echo "  ok   no problems"
}

./make-fixtures.sh
case "$LEVEL" in
  lint) lint ;;
  quick) lint; serve "$ROOT" 8765; suite smoke; suite gestures; webkit smoke; webkit keyboard ;;
  full) lint; serve "$ROOT" 8765; suite smoke; suite gestures; webkit smoke; webkit keyboard; suite features; webkit features; suite crash ;;
  webkit) serve "$ROOT" 8765; webkit smoke; webkit keyboard; webkit features ;;
  speech) serve "$ROOT" 8765; suite speech; webkit speech ;;
  all) lint; serve "$ROOT" 8765; suite smoke; suite gestures; webkit smoke; webkit keyboard; suite features; webkit features; suite crash; suite speech; webkit speech ;;
  compare)
    REF=${2:?usage: run.sh compare <git ref>}
    OLD=$(mktemp -d)
    git -C "$ROOT" worktree add -q --detach "$OLD/app" "$REF"
    trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done; git -C "$ROOT" worktree remove --force "$OLD/app"' EXIT
    serve "$OLD/app" 8767; serve "$ROOT" 8765
    BASE=http://localhost:8767/ node features.js | grep '  dump ' > "$OLD/before.txt" || true
    BASE=http://localhost:8765/ node features.js | grep '  dump ' > "$OLD/after.txt" || true
    if diff "$OLD/before.txt" "$OLD/after.txt"; then echo "  ok   same behaviour as $REF ($(wc -l < "$OLD/after.txt") lines)"; else echo "  differences above (< $REF, > this version)"; fi
    ;;
  *) echo "unknown level: $LEVEL"; exit 2 ;;
esac
