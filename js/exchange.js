// Bookmarks out and in: a Markdown file that reads well on its own, and that Bork Mark on
// another device can take back in, for the same book.

import { renderInfo } from './info.js';
import { log } from './log.js';
import { renderMarks } from './marks.js';
import { chapterAt, chapterOutline, cur } from './player.js';
import { runQueue } from './queue.js';
import { rematch, shareText } from './quotes.js';
import { frontMatter } from './sources/markdown.js';
import { save } from './state.js';
import { findInBook, tokenize } from './text/book.js';
import { $, fmt, toast } from './ui/dom.js';
import { VERSION } from './version.js';

// What is kept of each bookmark, in a comment under it that Markdown viewers
// don't show. Places in the text are not kept: they are found again in
// whatever text the other device has.
const KEEP = ['t', 'created', 'status', 'before', 'after', 'transcript', 'page', 'section'];
const yaml = (s) => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// The whole file, in book order under chapter headings (and part headings where the book has parts).
export function bookmarksMarkdown(b) {
  const marks = [...b.marks].sort((x, y) => x.t - y.t);
  const out = ['---', 'title: ' + yaml(b.title), 'author: ' + yaml(b.author)];
  if (b.publisher) out.push('publisher: ' + yaml(b.publisher));
  if (b.year) out.push('year: ' + yaml(b.year));
  out.push('duration: ' + Math.round(b.duration), 'bookmarks: ' + marks.length, 'exported: ' + day(Date.now()), 'app: ' + yaml('Bork Mark ' + VERSION), '---', '',
    '# ' + b.title, '', [b.author, marks.length + (marks.length === 1 ? ' bookmark' : ' bookmarks'), 'exported ' + new Date().toLocaleDateString([], { dateStyle: 'long' })].filter(Boolean).join(' · '), '');
  const order = [...new Set(marks.map((m) => chapterAt(b, m.t).i))], places = new Map(chapterOutline(b, order).map((o, k) => [order[k], o]));
  let last = null;
  for (const m of marks) {
    const c = chapterAt(b, m.t);
    if (c.count > 1 && c.i !== last) {
      const place = places.get(c.i) || { depth: 0 };
      if (place.missing) out.push('## ' + place.parent, '');
      out.push((place.depth ? '### ' : '## ') + c.title, '');
      last = c.i;
    }
    // The quote and its citation as they are shared, as a block quote.
    const said = m.status === 'done' || m.transcript ? shareText(b, m) : 'No quote yet.\n\n— ' + b.title + ' (audiobook, ' + fmt(m.t) + ')';
    out.push('**' + fmt(m.t) + '**' + (m.page ? ' · p. ' + m.page : '') + ' · ' + new Date(m.created).toLocaleDateString([], { dateStyle: 'medium' }), '',
      said.split('\n').map((l) => ('> ' + l).trimEnd()).join('\n'), '');
    const kept = {};
    for (const k of KEEP) if (m[k] != null && m[k] !== '') kept[k] = m[k];
    out.push('<!-- bork ' + JSON.stringify(kept).replace(/--/g, '-\\u002d') + ' -->', '');
  }
  return out.join('\n');
}

// Hands the file to the share sheet where there is one, and saves it otherwise.
async function exportBookmarks() {
  const b = cur && cur.book;
  if (!b || !b.marks.length) { toast('No bookmarks to export', 'warn'); return; }
  const name = (b.title || 'bookmarks').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/ /g, '-').slice(0, 60) + '-bookmarks.md';
  const file = new File([bookmarksMarkdown(b)], name, { type: 'text/markdown' });
  log('exporting ' + b.marks.length + ' bookmarks as ' + name);
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'), url = URL.createObjectURL(file);
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('Bookmarks saved');
}

// Whether an exported file is for this book. The length of the audio decides
// when it is close; when the edition differs a little, the title must agree too.
const bare = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sameBook(meta, b) {
  const length = Number(meta.duration), off = length > 0 ? Math.abs(length - b.duration) : Infinity;
  const titles = !!bare(meta.title) && (bare(meta.title) === bare(b.title) || bare(b.title).startsWith(bare(meta.title) + ' ') || bare(meta.title).startsWith(bare(b.title) + ' '));
  if (off <= Math.max(3, b.duration * 0.002)) return true;
  return titles && off <= b.duration * 0.03;
}
// The bookmarks in an exported file: [{ t, created, status, … }].
export function readBookmarks(source) {
  const { meta, body } = frontMatter(source.replace(/\r/g, '')), marks = [];
  for (const m of body.matchAll(/<!-- bork (\{.*?\}) -->/g)) {
    try { const k = JSON.parse(m[1]); if (typeof k.t === 'number' && k.t >= 0) marks.push(k); } catch (e) { /* a damaged line: skip it */ }
  }
  return { meta, marks };
}
// Adds a file's bookmarks to the open book, leaving out any it already has.
function importBookmarks(source) {
  const b = cur.book, { meta, marks } = readBookmarks(source);
  if (!marks.length) { toast('No bookmarks in that file', 'warn'); return; }
  if (!sameBook(meta, b)) {
    log('bookmarks are for another book: ' + (meta.title || 'untitled') + (Number(meta.duration) ? ', ' + fmt(Number(meta.duration)) : ''));
      toast('Those are for another book', 'warn');
    log('bookmarks not imported: file is for "' + meta.title + '" ' + meta.duration + ' s, this book is "' + b.title + '" ' + Math.round(b.duration) + ' s');
    return;
  }
  let added = 0;
  for (const k of marks) {
    if (k.t > b.duration + 1 || b.marks.some((m) => Math.abs(m.t - k.t) < 1.5)) continue;
    const m = { id: crypto.randomUUID(), t: k.t, created: Number(k.created) || Date.now() };
    if (k.status === 'done' && (k.before || k.after)) {
      Object.assign(m, { status: 'done', before: k.before || '', after: k.after || '', page: k.page || '', section: k.section || '' });
      // Found again in this device's text, so it can be trimmed and counted on here.
      if (cur.text) {
        const before = tokenize(m.before).words, loc = findInBook(cur.text, before.concat(tokenize(m.after).words), before.length);
        if (loc) m.loc = [loc.start, loc.split, loc.end];
      }
    } else if (k.transcript && cur.text) m.status = 'pending';   // heard on a device without the text: listen again here
    else if (k.transcript) Object.assign(m, { status: 'transcribed', transcript: k.transcript });
    else m.status = 'pending';
    b.marks.push(m);
    added++;
  }
  b.marks.sort((x, y) => y.created - x.created);
  save(true); renderMarks(); renderInfo(); rematch(); runQueue();
  log('imported ' + added + ' of ' + marks.length + ' bookmarks');
  toast(added ? 'Added ' + added + (added === 1 ? ' bookmark' : ' bookmarks') + (added < marks.length ? ' (' + (marks.length - added) + ' already here)' : '') : 'All of those are already here');
}

$('marksExport').addEventListener('click', exportBookmarks);
$('marksFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  try { importBookmarks(await f.text()); } catch (err) { log('bookmark import failed: ' + ((err && err.message) || err)); toast('Could not read that file', 'warn'); }
});
