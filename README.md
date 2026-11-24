# bork-mark
A way to save bookmarks in audiobooks while frolicking around

## Deploying

The app is plain files served by GitHub Pages from the `gh-pages` branch. Before pushing a new version, run `./stamp.sh`: it writes a build number into `app.js` and `version.json`, which is how an installed copy notices that a newer version is available.
