#!/bin/sh
# Stamps a copy of the app for publishing. Usage: ./stamp.sh [version] [channel]
#
# Writes the version, the channel (release or dev), a build number and the
# commit into js/version.js and version.json. Settings shows the version; the app compares build
# numbers to notice a newer one. The build number is the time now, or $BUILD
# when that is set. The deploy workflow runs this; there is no need to run it
# by hand.
set -e
cd "$(dirname "$0")"
B=${BUILD:-$(date +%s)}
V=${1:-$(tr -d ' \n' < VERSION)}
C=${2:-release}
H=${COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}
sed -i "s/^export const BUILD = '[0-9]*';/export const BUILD = '$B';/" js/version.js
sed -i "s/^export const VERSION = '[^']*';/export const VERSION = '$V';/" js/version.js
sed -i "s/^export const CHANNEL = '[^']*';/export const CHANNEL = '$C';/" js/version.js
sed -i "s/^export const COMMIT = '[^']*';/export const COMMIT = '$H';/" js/version.js
printf '{"build":"%s","version":"%s","channel":"%s","commit":"%s"}\n' "$B" "$V" "$C" "$H" > version.json
grep -q "export const BUILD = '$B';" js/version.js
grep -q "export const VERSION = '$V';" js/version.js
grep -q "export const CHANNEL = '$C';" js/version.js
grep -q "export const COMMIT = '$H';" js/version.js
# The development copy installs under its own name.
if [ "$C" = dev ]; then
  sed -i 's/"name": "Bork Mark"/"name": "Bork Mark (dev)"/; s/"short_name": "Bork Mark"/"short_name": "Bork dev"/' manifest.webmanifest
fi
echo "build $B, version $V, channel $C, commit $H"
