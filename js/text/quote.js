// Cutting quotes out of the book text: around a located bookmark, by whole paragraphs, and
// into sentences for trimming.

// Book text before and after the bookmark, widened to whole sentences.
export function passage(book, loc) {
  const { text, starts, ends } = book;
  const n = starts.length;
  if (!n) return { before: '', after: '' };
  let a = starts[Math.min(loc.start, n - 1)];
  let z = ends[Math.max(0, Math.min(loc.end, n) - 1)];
  const mid = loc.split >= n ? text.length : starts[loc.split];
  const back = text.slice(Math.max(0, a - 300), a);
  const m = back.match(/[\s\S]*[.!?…]["”’)]*\s+|[\s\S]*\n/);
  if (m) a = a - back.length + m[0].length;
  const fwd = text.slice(z, z + 300).match(/^[^\n]*?[.!?…]["”’)]*(?=\s|$)/);
  if (fwd) z += fwd[0].length;
  return { before: text.slice(a, Math.max(a, mid)), after: text.slice(Math.max(a, mid), Math.max(mid, z)) };
}

const PARA_MAX = 2500;   // most characters taken on either side of the bookmark
const PARA_MIN = 120;    // widen past the requested count until at least this long

// The bookmarked paragraph plus nBefore / nAfter neighbours. Bounded both
// ways, because some books put every line in its own paragraph and others
// have no paragraph breaks at all.
function paragraphs(book, at, nBefore, nAfter) {
  const { text, starts } = book;
  const mid = at >= starts.length ? text.length : starts[at];
  const prevStart = (p) => {          // start of the paragraph before the one starting at p
    let e = p;
    while (e > 0 && /\s/.test(text[e - 1])) e--;
    return e === 0 ? null : text.lastIndexOf('\n', e - 1) + 1;
  };
  const nextEnd = (p) => {            // end of the paragraph after the one ending at p
    let b = p;
    while (b < text.length && /\s/.test(text[b])) b++;
    if (b >= text.length) return null;
    const e = text.indexOf('\n', b);
    return e < 0 ? text.length : e;
  };
  let a = text.lastIndexOf('\n', mid - 1) + 1;
  let z = text.indexOf('\n', mid);
  if (z < 0) z = text.length;
  const back = () => { const q = prevStart(a); if (q === null || mid - q > PARA_MAX) return false; a = q; return true; };
  const fwd = () => { const q = nextEnd(z); if (q === null || q - mid > PARA_MAX) return false; z = q; return true; };
  for (let i = 0; i < nBefore && back(); i++);
  for (let i = 0; i < nAfter && fwd(); i++);
  for (let i = 0; i < 40 && z - a < PARA_MIN; i++) { const b = back(), f = fwd(); if (!b && !f) break; }

  let before = text.slice(a, mid), after = text.slice(mid, z);
  if (before.length > PARA_MAX) {     // one enormous paragraph: keep whole sentences near the bookmark
    const cut = before.slice(before.length - PARA_MAX), m = cut.match(/[.!?…]["”’)]*\s+/);
    before = '…' + (m ? cut.slice(m.index + m[0].length) : cut.slice(cut.indexOf(' ') + 1));
  }
  if (after.length > PARA_MAX) {
    const cut = after.slice(0, PARA_MAX), m = cut.match(/[\s\S]*[.!?…]["”’)]*(?=\s)/);
    after = (m ? m[0] : cut.slice(0, cut.lastIndexOf(' '))) + '…';
  }
  return { before, after };
}

// The quote for a located bookmark: either the stretch that was heard
// (capture.mode "time") or whole paragraphs around the bookmark ("paras").
export function quoteAt(book, loc, capture) {
  if (capture && capture.mode === 'paras') return paragraphs(book, loc.split, capture.parasBefore, capture.parasAfter);
  return passage(book, loc);
}

// ---------- sentences, for trimming a quote ----------
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Co|No|vs|etc|Inc|Ltd|Vol|pp?|[A-Z])\.$/;
// Sentences of the paragraphs that overlap the characters [from, to) of the
// text, in order, as {a, b, p}: character range and paragraph number.
export function sentencesIn(text, from, to) {
  let start = text.lastIndexOf('\n', Math.max(0, from) - 1) + 1;
  let stop = text.indexOf('\n', Math.min(text.length, to));
  if (stop < 0) stop = text.length;
  const out = [];
  let p = 0;
  while (start < stop) {
    let end = text.indexOf('\n', start);
    if (end < 0 || end > stop) end = stop;
    if (/\S/.test(text.slice(start, end))) {
      // one paragraph: break after . ! ? … (and any closing quotes) when a new sentence clearly begins
      let s = start;
      const stopper = /[.!?…]+["”’)\]]*\s+/g;
      stopper.lastIndex = start;
      for (let m; (m = stopper.exec(text)) && m.index < end;) {
        const next = m.index + m[0].length;
        if (next >= end) break;
        const lead = text.slice(Math.max(s, m.index - 5), m.index + 1);
        if (ABBREVIATION.test(lead) || /[\p{Ll}]/u.test(text[next])) continue;   // "Mr. Ford", "U. S.", or the sentence carries on in lower case
        out.push({ a: s, b: m.index + m[0].trimEnd().length, p });
        s = next;
      }
      while (s < end && /\s/.test(text[s])) s++;
      let b = end;
      while (b > s && /\s/.test(text[b - 1])) b--;
      if (b > s) out.push({ a: s, b, p });
      p++;
    }
    start = end + 1;
  }
  return out;
}
