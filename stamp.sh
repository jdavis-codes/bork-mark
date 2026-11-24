#!/bin/sh
# Stamps a copy of the app for publishing. Usage: ./stamp.sh [version] [channel]
#
# Gives the build a number (the current time) in both app.js and version.json;
# the app compares the two to notice a newer version. The version and channel
# (release or dev) are shown in Settings. The deploy workflow runs this; run it
# yourself only when publishing by hand.
set -e
cd "$(dirname "$0")"
B=$(date +%s)
V=${1:-$(tr -d ' \n' < VERSION)}
C=${2:-release}
sed -i "s/^const BUILD = '[0-9]*';/const BUILD = '$B';/" app.js
sed -i "s/^const VERSION = '[^']*';/const VERSION = '$V';/" app.js
sed -i "s/^const CHANNEL = '[^']*';/const CHANNEL = '$C';/" app.js
printf '{"build":"%s","version":"%s","channel":"%s"}\n' "$B" "$V" "$C" > version.json
grep -q "const BUILD = '$B';" app.js
grep -q "const VERSION = '$V';" app.js
grep -q "const CHANNEL = '$C';" app.js
# The development copy installs under its own name.
if [ "$C" = dev ]; then
  sed -i 's/"name": "Bork Mark"/"name": "Bork Mark (dev)"/; s/"short_name": "Bork Mark"/"short_name": "Bork dev"/' manifest.webmanifest
fi
echo "build $B, version $V, channel $C"
