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
// "Chapter Five", "Chapter IV: …", "5. The Title". Null when it names none.
export function chapterNumber(s) {
  let m = /\bchapter\s+(\d+|[ivxlc]+|[a-z]+)\b/i.exec(s || '');
  if (m) return toNumber(m[1]);
  m = /^\s*(\d{1,2})\s*[.:)–—-]\s+\S/.exec(s || '');
  return m ? Number(m[1]) : null;
}

const KINDS = 'figure|fig\\.?|table|chart|map|exhibit|worksheet|box|illustration|plate|diagram|graph|handout|form|appendix';
const CAPTION = new RegExp('^(' + KINDS + ')\\s+((?:[A-Za-z]\\.?)?\\d+(?:[.–-]\\d+)*[a-z]?|[A-Z])(?!\\w|\\.\\d)\\s*[.:–—-]?\\s*(.*)$', 'i');
const HEADING = /^chapter\s+(\d+|[ivxlc]+|[a-z]+)(?!\w)\s*[.:–—-]?\s*(.*)$/i;
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
// places worth jumping to: { label, title, page (from 1), ch (chapter or null) }.
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
  let chapter = null;
  for (const e of found) {
    const key = e.kind === 'section' ? 'section ' + e.label.toLowerCase() + ' ' + e.page : e.label.toLowerCase();
    if (seen.has(key)) { if (e.heading) chapter = e.ch; continue; }
    seen.add(key);
    if (e.heading) chapter = e.ch;
    // Appendices and other back matter come after the chapters, not inside the last one.
    else if (e.ch == null && (e.kind === 'appendix' || e.kind === 'section')) chapter = null;
    entries.push({ kind: e.kind, label: e.label, title: e.title, page: e.page, ch: e.ch != null ? e.ch : chapter });
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
