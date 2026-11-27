// Tidying text from any source: tables written as plain lines, and hard-wrapped lines.

// ---------- tables written as plain lines ----------
// Many EPUBs don't mark tables up as tables: each row is just a short line
// of text. This finds runs of at least three such lines and returns them as
// table figures {at, kind, cap, rows}.
export function findTextTables(text) {
  const NUMBER = /[$£€]?\d[\d,.]*(?:[-–/]\d+)?%?/g;
  const lines = [];
  let pos = 0;
  for (const raw of text.split('\n')) { lines.push({ s: raw.trim(), at: pos }); pos += raw.length + 1; }
  // A row is a short line with at least two numbers that is either mostly
  // numbers ("1909-10 $950 18,664 cars") or a label ending in one ("Repairs
  // per acre .026"). Ordinary sentences that mention two numbers are neither.
  const isRow = (l) => {
    if (!l || !l.s || l.s.length > 90 || (l.s.match(NUMBER) || []).length < 2) return false;
    const words = l.s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const numeric = words.filter((w) => /\d/.test(w)).length;
    return numeric / words.length >= 0.4 || /\d[%.)"”]*$/.test(l.s);
  };
  // Split a row into cells: on dot leaders, tabs or wide gaps if it has them,
  // otherwise start a new cell at each number.
  const cells = (s) => {
    const parts = s.split(/\s*(?:\.\s){2,}\.?\s*|\t+|\s{2,}/).filter(Boolean);
    if (parts.length > 1) return parts;
    const out = [];
    for (const word of s.split(' ')) {
      const prev = out[out.length - 1];
      if (!out.length || (/\d/.test(word) && !/\bto$/.test(prev))) out.push(word); else out[out.length - 1] = prev + ' ' + word;
    }
    return out;
  };
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i])) continue;
    // Extend over following rows, allowing blank lines and a one-line note between rows.
    let last = i, j = i + 1, count = 1;
    while (j < lines.length && j - last <= 3) {
      if (isRow(lines[j])) { count++; last = j; }
      else if (lines[j].s.length > 90) break;
      j++;
    }
    let notes = 0;
    for (let k = i; k <= last; k++) if (lines[k].s && !isRow(lines[k])) notes++;
    if (count >= 3 && notes * 3 <= count) {   // mostly rows, with at most the odd note between them
      let h = i - 1;
      while (h >= 0 && !lines[h].s) h--;
      const header = h >= 0 && i - h <= 2 && lines[h].s.length <= 60 && !/\d/.test(lines[h].s) && !/[.!?;,:]$/.test(lines[h].s) ? lines[h] : null;
      const rows = [];
      for (let k = i; k <= last; k++) if (lines[k].s) rows.push(isRow(lines[k]) ? cells(lines[k].s) : [lines[k].s]);
      const width = rows.map((r) => r.length).sort((a, b) => a - b)[rows.length >> 1];
      if (header) {
        let head = cells(header.s);
        if (head.length === 1 && header.s.split(' ').length === width) head = header.s.split(' ');
        rows.unshift(head);
      }
      tables.push({ at: (header || lines[i]).at, kind: 'table', cap: header ? header.s.replace(/\s*(?:\.\s){2,}\.?\s*/g, ', ') : rows[0].join(', '), rows, plain: true });
    }
    i = last;
  }
  return tables;
}

// ---------- hard-wrapped text ----------
// Some books break every line at about the same width, inside paragraphs. If
// the text looks like that, the line breaks that are only wrapping are turned
// into spaces: a break is wrapping when the next line's first word would not
// have fitted on the line before it. Each break becomes exactly one space, so
// every character keeps its position and saved places in the text stay valid.
export function unwrapLines(text) {
  const lines = text.split('\n');
  const lengths = lines.map((l) => l.length).filter((n) => n > 20).sort((a, b) => a - b);
  if (lengths.length < 200) return text;
  const typical = lengths[Math.floor(lengths.length * 0.9)], width = lengths[Math.floor(lengths.length * 0.99)];
  // Real paragraphs vary widely in length and run long; wrapped lines bunch up just under one width.
  if (typical > 110 || lengths.filter((n) => n >= typical - 12).length / lengths.length < 0.3) return text;
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1], line = lines[i], firstWord = (/^\S+/.exec(line) || [''])[0];
    out += (before && line && before.length + 1 + firstWord.length > width ? ' ' : '\n') + line;
  }
  return out;
}
