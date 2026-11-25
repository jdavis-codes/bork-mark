// The book text as an index of words, whatever file it came from: tokenizing, three-word
// lookups, and finding where a run of heard words sits in the text. Text search can build on
// this index.

// The last entry of a {label, at} list at or before a character position.
export function entryAt(list, at) {
  let found = null;
  for (const x of list || []) { if (x.at <= at) found = x; else break; }
  return found;
}

// ---------- matching ----------
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const norm = (w) => w.toLowerCase().replace(/['’]/g, '');

export function tokenize(text) {
  const words = [], starts = [], ends = [];
  for (const m of text.matchAll(WORD)) {
    words.push(norm(m[0])); starts.push(m.index); ends.push(m.index + m[0].length);
  }
  return { words, starts, ends };
}

const gram = (w, i) => w[i] + ' ' + w[i + 1] + ' ' + w[i + 2];

export function buildBook(text) {
  const tok = tokenize(text);
  const grams = new Map();
  for (let i = 0; i + 2 < tok.words.length; i++) {
    const k = gram(tok.words, i);
    const a = grams.get(k);
    if (a) a.push(i); else grams.set(k, [i]);
  }
  return { text, ...tok, grams };
}

// Finds where the transcript words sit in the book. Each shared three-word
// run votes for an offset between the two; the densest offset wins.
// `split` is the transcript word index at the bookmark moment.
export function locate(book, tw, split) {
  const BIN = 40, pairs = [], votes = new Map();
  for (let j = 0; j + 2 < tw.length; j++) {
    const hits = book.grams.get(gram(tw, j));
    if (!hits || hits.length > 40) continue;
    for (const p of hits) {
      pairs.push([j, p]);
      const b = Math.floor((p - j) / BIN);
      votes.set(b, (votes.get(b) || 0) + 1);
    }
  }
  let best = null, bestScore = 0;
  for (const [b, v] of votes) {
    const s = v + (votes.get(b + 1) || 0);
    if (s > bestScore) { bestScore = s; best = b; }
  }
  if (best === null) return null;
  const near = pairs.filter(([j, p]) => { const b = Math.floor((p - j) / BIN); return b === best || b === best + 1; });
  const ds = near.map(([j, p]) => p - j).sort((x, y) => x - y);
  const mid = ds[ds.length >> 1];
  const band = near.filter(([j, p]) => Math.abs(p - j - mid) <= 25).sort((x, y) => x[0] - y[0]);
  const matched = new Set(band.map(([j]) => j)).size;
  const confidence = matched / Math.max(1, tw.length - 2);
  // A handful of stray hits is noise, not a location.
  if (matched < 5 || confidence < 0.15) return { confidence, found: false };
  const first = band[0], last = band[band.length - 1];
  let anchor = band[0];
  for (const pr of band) if (Math.abs(pr[0] - split) < Math.abs(anchor[0] - split)) anchor = pr;
  const clamp = (i) => Math.max(0, Math.min(book.words.length, i));
  return {
    // Span only what actually matched, so narrator extras ("End of chapter
    // two") don't pull in unrelated text; passage() widens to full sentences.
    start: clamp(first[1]),
    split: Math.max(first[1], Math.min(last[1] + 3, clamp(anchor[1] + (split - anchor[0])))),
    end: clamp(last[1] + 3),
    confidence, found: true,
    anchorGap: Math.abs(anchor[0] - split),
  };
}

// Where a transcribed bookmark sits in the book, as word indexes, or null
// when it isn't there.
export function findInBook(book, words, split) {
  const loc = locate(book, words, split);
  if (!loc || !loc.found) return null;
  return { start: loc.start, split: loc.split, end: loc.end, confidence: loc.confidence };
}
