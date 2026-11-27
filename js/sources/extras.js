// The PDF of extras that comes with many audiobooks (figures, tables, notes, worksheets). Every
// publisher lays these out differently, so this only looks for the few things most have in common.

import { openPdf } from './pdf.js';

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function toNumber(s) {
  s = s.toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (WORDS.includes(s)) return WORDS.indexOf(s) + 1;
  if (!/^[ivxlc]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]], next = ROMAN[s[i + 1]] || 0; n += v < next ? -v : v; }
  return n;
}
// The chapter a heading or an audio chapter's name speaks of: "Chapter 5",
// "Chapter Five", "Chapter IV: …", "5. The Title", "II: The Title", "13 The Title". Null when it names none.
export function chapterNumber(s) {
  let m = /\bchapter\s+(\d+|[ivxlc]+|[a-z]+)\b/i.exec(s || '');
  if (m) return toNumber(m[1]);
  m = /^\s*(\d{1,2})\s*[.:)–—-]\s+\S/.exec(s || '');
  if (m) return Number(m[1]);
  m = /^\s*([IVXLC]+)\s*[.:)–—-]\s+\S/.exec(s || '');
  if (m) return toNumber(m[1]);
  // A bare number before a capitalised title: "13 Managing College with ADHD".
  m = /^\s*(\d{1,2})\s+\p{Lu}/u.exec(s || '');
  return m ? Number(m[1]) : null;
}

// Whether two chapter names speak of the same chapter: by number when both
// have one, otherwise by their titles, where one may carry a subtitle the
// other lacks ("2 What Do You Have to Do? The To-Do List" / "What Do You Have to Do?").
const bareTitle = (s) => (s || '').toLowerCase().replace(/^\s*(chapter\s+)?(\d+|[ivxlc]+)\s*[.:)–—-]?\s+/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sameChapter(a, b) {
  const x = chapterNumber(a), y = chapterNumber(b);
  if (x != null && y != null) return x === y;
  const s = bareTitle(a), t = bareTitle(b);
  if (s.length < 6 || t.length < 6) return false;
  return s === t || s.startsWith(t + ' ') || t.startsWith(s + ' ');
}

// Where each of a list of chapter names sits in the book: at the top, or
// inside a part. The book's contents list says, when it records nesting and
// has an entry of that name. Otherwise chapters that follow a "Part" are taken
// to be inside it, until the back of the book.
//
// For each name: { depth: 0 or 1, parent: the part's name or null, missing:
// true when that part is not itself in the list just above }. A list that can
// show the part's name first passes `insert`; in one that can't, a chapter
// whose part is absent counts as top-level.
const PART = /^\s*(part|book)\s+(\d+|[ivxlc]+|[a-z]+)\b/i;
const BACK = /^\s*(conclusion|epilogue|afterword|acknowledge?ments|notes|appendix|appendices|index|bibliography|references|glossary|about the|also by|copyright|credits|closing)\b/i;
// A contents list kept from before nesting was recorded is flat. If it names
// parts, the entries after each one are inside it, until the back of the book.
// Some contents lists put every chapter inside one entry named after the book.
// That entry is a wrapper, not a part: its chapters count as top-level.
function withoutWrapper(toc) {
  const parents = [];
  let inside = 0, top = -1;
  toc.forEach((e, k) => { if (!(e.depth > 0)) top = k; else { if (!parents.includes(top)) parents.push(top); inside++; } });
  if (parents.length !== 1 || parents[0] < 0 || inside < toc.length * 0.6) return toc;
  let under = false;
  return toc.map((e, k) => {
    if (!(e.depth > 0)) { under = k === parents[0]; return e; }
    return under ? { ...e, depth: e.depth - 1 } : e;
  });
}
function withNesting(list) {
  const toc = withoutWrapper(list);
  if (toc.some((e) => e.depth > 0) || !toc.some((e) => PART.test(e.label))) return toc;
  let inPart = false;
  return toc.map((e) => {
    if (PART.test(e.label)) { inPart = true; return { ...e, depth: 0 }; }
    if (BACK.test(e.label)) inPart = false;
    return { ...e, depth: inPart ? 1 : 0 };
  });
}
export function outline(names, list = [], insert = false) {
  const toc = withNesting(list), nested = toc.some((e) => e.depth > 0);
  let part = null, shown = null;
  return names.map((name) => {
    const k = nested ? toc.findIndex((e) => sameChapter(name, e.label)) : -1;
    let parent = null;
    if (k >= 0) {
      const depth = toc[k].depth || 0;
      for (let n = k - 1; depth > 0 && n >= 0; n--) if ((toc[n].depth || 0) < depth) { parent = toc[n].label; break; }
      if (!parent) part = PART.test(name) ? name : null;
    } else if (PART.test(name)) part = name;
    else if (BACK.test(name)) part = null;
    else parent = part;
    let missing = !!parent && !(shown && sameChapter(parent, shown));
    if (missing && !insert) { parent = null; missing = false; }
    shown = parent || name;
    return { depth: parent ? 1 : 0, parent, missing };
  });
}

const KINDS = 'figure|fig\\.?|table|chart|map|exhibit|worksheet|box|illustration|plate|diagram|graph|handout|form|appendix';
const CAPTION = new RegExp('^(' + KINDS + ')\\s+((?:[A-Za-z]\\.?)?\\d+(?:[.–-]\\d+)*[a-z]?|[A-Z])(?!\\w|\\.\\d)\\s*[.:–—-]?\\s*(.*)$', 'i');
const HEADING = /^chapter\s+(\d+|[ivxlc]+|[a-z]+)(?!\w)\s*[.:–—-]?\s*(.*)$/i;
// Books divide themselves in other ways too: "Part 2", "Rule #3", "Lesson 4", and
// parts with a name of their own, alone on a line: "Introduction", "Conclusion".
const DIVISION = /^(part|rule|lesson|step|law|principle|habit|book|week|day|section)\s*#?\s*(\d+|[ivxlc]+|[a-z]+)(?!\w)\s*[.:–—-]?\s*(.*)$/i;
const NAMED = /^(introduction|prologue|preface|foreword|conclusion|epilogue|afterword|acknowledge?ments)$/i;
const capital = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
const SPACED = new RegExp('^(' + KINDS.replace('fig\\.?|', '') + '|CHAPTER)(?=.)', 'i');
// Some books letter-space their captions: "F I G U R E 6 . 1 0 . The relationship…".
// Close up the spaced run at the start, stopping where the caption's number ends.
function unspace(line) {
  const words = line.trim().split(/\s+/);
  if (words.length < 4 || !words.slice(0, 3).every((w) => /^[A-Z]{1,2}$/.test(w))) return line;
  let run = '', i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w.length > 2 || !/^[A-Z\d.]+$/.test(w)) break;
    if (/^[A-Z]$/.test(w) && /\d\.$/.test(run)) break;   // "… 1.1. A map of": the A starts the title
    run += w;
  }
  return run.replace(SPACED, '$1 ') + ' ' + words.slice(i).join(' ');
}
const tidy = (line) => unspace(line).replace(/\s+/g, ' ').replace(/(\d) ?\. ?(?=\d)/g, '$1.').trim();
// Captions and headings begin with a capital (or nothing follows the number);
// "Table 2.1 shows that…" is a sentence about one, not the thing itself.
const opens = (rest) => !rest || /^[\p{Lu}\d"“‘(]/u.test(rest);
const title = (s) => { s = s.replace(/[\s.:–—-]+$/, ''); return s.length > 90 ? s.slice(0, 88).trimEnd() + '…' : s; };
const allCaps = (s) => s === s.toUpperCase() && /\p{L}{3}/u.test(s);
// A caption's title: its first sentence, carried onto the next line when the
// line plainly breaks off ("…IN THE MARRIAGE AND" / "FAMILY PROGRAM").
function captionTitle(rest, next) {
  let text = rest;
  const ended = /[.?!]["”)]?$/.test(rest) && !/\bvs\.$/i.test(rest) && rest.length >= 30;
  if (rest && next && !ended && (/\b(and|or|of|the|in|for|to|a|an|vs\.?|with|on|by|from|between)$/i.test(rest) || (allCaps(rest) && allCaps(next)) || (rest.length > 60 && /^\p{Ll}/u.test(next)) || rest.length < 30 && /^[\p{Ll}“"(]/u.test(next))) text += ' ' + next;
  const stop = /^(.*?[^.]{3}(?<!\b(?:vs|e\.g|i\.e|etc|St|Dr|Mr|Mrs|No|cf))[.?!])(?=\s|$)/.exec(text);
  return title(sentenceCase(stop ? stop[1] : text));
}
const sentenceCase = (s) => (s === s.toUpperCase() && /\p{L}{3}/u.test(s) ? s[0] + s.slice(1).toLowerCase() : s);

// One line read as a caption ("Figure 1.2. Title") or a chapter heading, or null.
function readLine(raw) {
  const line = tidy(raw);
  if (line.length > 200 || /(\. ?){4,}/.test(line)) return null;   // a row of dots: the PDF's own contents page
  let m = HEADING.exec(line);
  if (m && line.length < 80 && opens(m[2]) && toNumber(m[1]) != null) {
    return { kind: 'chapter', label: 'Chapter ' + toNumber(m[1]), title: title(sentenceCase(m[2])), ch: toNumber(m[1]), heading: true };
  }
  m = DIVISION.exec(line);
  if (m && line.length < 80 && opens(m[3]) && toNumber(m[2]) != null) {
    return { kind: 'chapter', label: capital(m[1]) + (/#/.test(line) ? ' #' : ' ') + toNumber(m[2]), title: title(sentenceCase(m[3])), ch: null, heading: true };
  }
  if (NAMED.test(line)) return { kind: 'chapter', label: capital(line), title: '', ch: null, heading: true };
  m = CAPTION.exec(line);
  if (!m || !opens(m[3]) || /^\d+$/.test(m[3])) return null;   // "Appendix A   32" is a contents line
  const id = m[2];
  if (!/\d/.test(id) && (id !== id.toUpperCase() || !/^(appendix|exhibit|table|figure|form|handout|worksheet)$/i.test(m[1]))) return null;
  const kind = m[1].toLowerCase().replace(/^fig\.?$/, 'figure');
  // "Table 5.2" belongs to chapter 5.
  const part = /^(\d+)[.–-]\d/.exec(id);
  return { kind, label: kind[0].toUpperCase() + kind.slice(1) + ' ' + id, title: '', rest: m[3], ch: part ? Number(part[1]) : null };
}

// From each page's lines, and the PDF's outline if it has one, a list of
// places worth jumping to: { label, title, page (from 1), ch (chapter number or null),
// grp (the name of the chapter or other division it falls under, or null) }.
export function findEntries(pages, outline = []) {
  const found = [];
  for (const o of outline) {
    if (/_|\bcopy$|\.(indd|pdf|docx?)$/i.test(o.title.trim())) continue;   // a file name left in by the typesetter
    // An outline often numbers its chapters without the word: "5 Putting the Plan into Motion".
    const numbered = /^\s*(\d{1,2})\s+(\p{Lu}.*)$/u.exec(o.title);
    const read = readLine(o.title);
    if (read && read.rest) read.title = captionTitle(read.rest, '');
    const e = read || (numbered ? { kind: 'chapter', label: 'Chapter ' + Number(numbered[1]), title: title(tidy(numbered[2])), ch: Number(numbered[1]), heading: true }
      : { kind: 'section', label: title(tidy(o.title)), title: '', ch: chapterNumber(o.title) });
    if (e.ch == null && o.ch != null) e.ch = o.ch;
    if (e.label) found.push({ ...e, page: o.page, listed: true });
  }
  pages.forEach((lines, p) => {
    lines.forEach((raw, i) => {
      const e = readLine(raw);
      if (!e) return;
      const next = lines[i + 1] && !readLine(lines[i + 1]) ? tidy(lines[i + 1]) : '';
      if (e.rest) e.title = captionTitle(e.rest, next);
      // A caption alone on its line usually has its title on the next.
      else if (!e.title && next.length > 2 && next.length < (e.heading ? 50 : 90) && opens(next) && !/^\d+$/.test(next)) {
        e.title = e.heading ? title(sentenceCase(next)) : captionTitle(next, lines[i + 2] && !readLine(lines[i + 2]) ? tidy(lines[i + 2]) : '');
      }
      found.push({ ...e, page: p + 1 });
    });
  });
  found.sort((a, b) => a.page - b.page || (b.listed ? 1 : 0) - (a.listed ? 1 : 0));
  // The first mention of each is kept: a table that runs on repeats its caption.
  const seen = new Set(), entries = [];
  let chapter = null, group = null;
  for (const e of found) {
    const key = e.kind === 'section' ? 'section ' + e.label.toLowerCase() + ' ' + e.page : e.label.toLowerCase();
    const again = seen.has(key);
    seen.add(key);
    if (e.heading) { chapter = e.ch; group = e.label; }
    // Appendices and other back matter come after the chapters, not inside the last one.
    else if (!again && e.ch == null && (e.kind === 'appendix' || e.kind === 'section')) { chapter = null; group = null; }
    if (again) continue;
    // "Table 5.2" says which chapter it belongs to; anything else belongs to the heading above it.
    const own = !e.heading && e.ch != null ? 'Chapter ' + e.ch : null;
    entries.push({ kind: e.kind, label: e.label, title: e.title, page: e.page, ch: e.ch != null ? e.ch : chapter, grp: own || group });
  }
  return entries;
}

// Reads an extras PDF: how many pages, their shape, and the entries found.
export async function readExtras(file, onProgress = () => {}) {
  const doc = await openPdf(file);
  try {
    const pages = [];
    let ratio = 1.4;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (i === 1) { const v = page.getViewport({ scale: 1 }); ratio = v.height / v.width; }
      const content = await page.getTextContent();
      const lines = [];
      let line = '';
      for (const item of content.items) { line += item.str; if (item.hasEOL) { lines.push(line); line = ''; } else line += ' '; }
      if (line.trim()) lines.push(line);
      pages.push(lines.filter((l) => l.trim()));
      page.cleanup();
      onProgress(i / doc.numPages);
    }
    const outline = [];
    try {
      const walk = async (items, depth, ch) => {
        for (const item of items || []) {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          const mine = chapterNumber(item.title) != null ? chapterNumber(item.title) : ch;
          if (Array.isArray(dest) && dest[0]) {
            const index = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
            outline.push({ title: item.title || '', page: index + 1, ch: mine });
          }
          if (depth < 2) await walk(item.items, depth + 1, mine);
        }
      };
      await walk(await doc.getOutline(), 1, null);
    } catch (e) { /* no usable outline */ }
    return { count: doc.numPages, ratio, entries: findEntries(pages, outline) };
  } finally {
    doc.destroy();
  }
}
