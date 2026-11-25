#!/bin/sh
# Stamps a copy of the app for publishing. Usage: ./stamp.sh [version] [channel]
#
# Writes the version, the channel (release or dev) and a build number into
# app.js and version.json. Settings shows the version; the app compares build
# numbers to notice a newer one. The build number is the time now, or $BUILD
# when that is set. The deploy workflow runs this; there is no need to run it
# by hand.
set -e
cd "$(dirname "$0")"
B=${BUILD:-$(date +%s)}
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
