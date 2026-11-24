#!/bin/sh
# Run before every deploy. Gives the build a number (the current time) in both
# app.js and version.json; the app compares the two to notice a newer version.
set -e
cd "$(dirname "$0")"
B=$(date +%s)
sed -i "s/^const BUILD = '[0-9]*';/const BUILD = '$B';/" app.js
printf '{"build":"%s"}\n' "$B" > version.json
grep -q "const BUILD = '$B';" app.js
echo "build $B"
