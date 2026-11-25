// Bookmarks related by meaning. Each quote is turned into an embedding (a
// list of 384 numbers standing for what it's about) by the sentence model in
// the speech worker, once, and kept with the bookmark. A search turns its
// words into an embedding the same way, and the bookmarks whose embeddings
// point the same way are related, whether or not they share any words.
//
// Nothing loads until bookmarks are searched. An embedding is kept as 384
// small whole numbers (base64, about 0.5 KB), with a fingerprint of the text
// it was made from, so a quote that changes (trimmed, re-cut) is redone.

import { crumb } from './log.js';
import { embed } from './speech.js';
import { save } from './state.js';

const MODEL = 'minilm-l6-v2';   // part of each fingerprint: a different model redoes them all
// How alike counts as related (1 is the same meaning, 0 unrelated). With this
// model, real matches between a search and a quote scored 0.24–0.54 and
// unrelated pairs up to 0.20. Anything well below the best match (under
// TAIL of its score) is dropped too, so a strong match doesn't drag weak ones in.
const RELATED = 0.22, TAIL = 0.6;
const BATCH = 16;               // quotes per request to the worker

const textOf = (m) => ((m.before || '') + (m.after || '') || m.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
function fingerprint(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return MODEL + ':' + (h >>> 0).toString(36) + ':' + text.length;
}
const pack = (v) => btoa(String.fromCharCode(...Uint8Array.from(v, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 127) & 255)));
const unpack = (s) => Int8Array.from(atob(s), (c) => c.charCodeAt(0) << 24 >> 24);

// Makes embeddings for the bookmarks that don't have an up-to-date one.
async function fill(marks) {
  const todo = marks.filter((m) => { const t = textOf(m); return t && (!m.vec || m.vec.k !== fingerprint(t)); });
  if (!todo.length) return;
  crumb('finding related bookmarks');
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH), texts = part.map(textOf);
      const vectors = await embed(texts);
      part.forEach((m, k) => { m.vec = { k: fingerprint(texts[k]), v: pack(vectors[k]) }; });
    }
    save(true);   // straight away: they took work to make
  } finally { crumb(null); }
}

// The bookmarks of `book` related by meaning to `query`, most alike first, as
// [{ m, score }], leaving out those whose ids are in `skip` (exact matches).
export async function relatedMarks(book, query, skip = new Set(), limit = 12) {
  await fill(book.marks);
  const [q] = await embed([query]);
  const out = [];
  for (const m of book.marks) {
    if (skip.has(m.id) || !m.vec) continue;
    const v = unpack(m.vec.v);
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += q[i] * v[i];
    const score = dot / 127;
    if (score >= RELATED) out.push({ m, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter((r) => r.score >= out[0].score * TAIL).slice(0, limit);
}
