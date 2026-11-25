// Searching the book text for what was typed: where it occurs, a short piece
// of text around each place, and the paragraph it sits in.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Letters with accents match without them ("cafe" finds "café"), and curly
// quotes match straight ones ("dont" doesn't, but "don't" finds "don’t").
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Every place the query occurs, as {at, end} character positions. A match
// starts at the beginning of a word, so "heal" finds "health" but not
// "wheal"; the words of a longer query may be split by any spacing or a line
// break. At most `limit`.
export function findMatches(text, query, limit = 500) {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp('(?<![\\p{L}\\p{N}])' + words.map(escape).join('[\\s\\u00a0]+'), 'giu');
  // Matching on the folded copy keeps positions, since folding only drops
  // marks: work out the folded copy once per text and keep it.
  const hay = folded(text);
  const out = [];
  for (let m; (m = re.exec(hay)) && out.length < limit;) {
    if (!m[0]) { re.lastIndex++; continue; }
    out.push({ at: toOriginal(text, m.index), end: toOriginal(text, m.index + m[0].length) });
  }
  return out;
}

// Folding can shorten the text (é is two characters after NFD, one after the
// mark is dropped, but some characters lose more). A table from folded to
// original positions keeps the results pointing at the right place.
let lastText = null, lastFolded = '', lastMap = null;
function folded(text) {
  if (text === lastText) return lastFolded;
  let out = '', map = null;
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    if (f.length !== 1 && !map) { map = []; for (let k = 0; k < out.length; k++) map.push(k); }
    if (map) for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
  }
  lastText = text; lastFolded = out; lastMap = map;
  return out;
}
function toOriginal(text, i) {
  if (text !== lastText || !lastMap) return i;
  return i >= lastMap.length ? text.length : lastMap[i];
}

// A short piece of text around a match, to show on two lines: some words
// before it, the match, and what follows, cut at word edges.
export function snippet(text, at, end, before = 50, after = 140) {
  let a = Math.max(0, at - before), z = Math.min(text.length, end + after);
  const para = text.lastIndexOf('\n', at - 1) + 1, paraEnd = text.indexOf('\n', end);
  if (a < para) a = para;                                  // stay inside the paragraph
  if (paraEnd >= 0 && z > paraEnd) z = paraEnd;
  if (a > para) { const sp = text.indexOf(' ', a); if (sp >= 0 && sp < at) a = sp + 1; }
  if (z < (paraEnd < 0 ? text.length : paraEnd)) { const sp = text.lastIndexOf(' ', z); if (sp > end) z = sp; }
  return { pre: (a > para ? '…' : '') + text.slice(a, at), hit: text.slice(at, end), post: text.slice(end, z) + (z < (paraEnd < 0 ? text.length : paraEnd) ? '…' : '') };
}

// The paragraph around a place, at most `max` characters either side.
export function paragraphAround(text, at, max = 2500) {
  let a = text.lastIndexOf('\n', at - 1) + 1, z = text.indexOf('\n', at);
  if (z < 0) z = text.length;
  a = Math.max(a, at - max); z = Math.min(z, at + max);
  return { a, z };
}
