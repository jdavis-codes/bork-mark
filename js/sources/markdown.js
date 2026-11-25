// Reads a Markdown file into the common book shape (see index.js): its headings become the
// contents, with their nesting; its tables become figures; the markup itself is taken out.

import { findTextTables } from '../text/cleanup.js';

// The "key: value" lines between --- at the top of a file, if it has them.
export function frontMatter(source) {
  const m = /^﻿?---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  const meta = {};
  if (!m) return { meta, body: source };
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: source.slice(m[0].length) };
}

// One line of prose with its Markdown taken out: emphasis, links, images, code marks, footnote marks, HTML.
function plain(line) {
  // A backslash keeps the mark after it as itself (\*not emphasis\*): set those aside first.
  const kept = [];
  return line
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, c) => String.fromCharCode(0xe100 + kept.push(c) - 1))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                      // pictures can't be read from a text file
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')    // [text](link)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')                  // [text][ref]
    .replace(/\[\^[^\]]+\]/g, '')                              // [^1]
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/[\ue100-\ue1ff]/g, (c) => kept[c.charCodeAt(0) - 0xe100])
    .replace(/[ \t]+/g, ' ').trim();
}
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => plain(c));

export async function readMarkdown(file) {
  const { meta, body } = frontMatter((await file.text()).replace(/\r/g, ''));
  const lines = body.split('\n'), paras = [], heads = [], figures = [];
  let para = [], fence = null, length = 0;
  // Paragraphs are joined with a blank line, so a position in the finished text is known as each is added.
  const push = (text) => { const at = length; paras.push(text); length += text.length + 2; return at; };
  const flush = () => { if (para.length) { const text = plain(para.join(' ')); if (text) push(text); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenced = /^\s*(```+|~~~+)/.exec(line);
    if (fence) { if (fenced && fenced[1][0] === fence) fence = null; else if (line.trim()) push(line.trim()); continue; }
    if (fenced) { flush(); fence = fenced[1][0]; continue; }
    if (!line.trim()) { flush(); continue; }
    // "# Heading", or a line underlined with === or ---
    const hash = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const under = !hash && para.length === 0 && line.trim() && /^\s{0,3}(=+|-+)\s*$/.exec(lines[i + 1] || '');
    if (hash || under) {
      flush();
      const label = plain(hash ? hash[2] : line);
      if (label) heads.push({ label, level: hash ? hash[1].length : under[1][0] === '=' ? 1 : 2, at: push(label) });
      if (under) i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }   // a rule
    // A table: rows of |cells|, the second of them dashes.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      flush();
      const rows = [cells(line)];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      figures.push({ at: length, kind: 'table', cap: '', rows });
      continue;
    }
    // Quoted lines and list items read as ordinary text; each list item is its own paragraph.
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { flush(); para.push(item[1]); continue; }
    para.push(line.replace(/^\s{0,3}(>\s?)+/, ''));
  }
  flush();
  const text = paras.join('\n\n');
  // A single top heading is the book's title, not a chapter; the contents start below it.
  const tops = heads.filter((h) => h.level === Math.min(...heads.map((x) => x.level)));
  const title = meta.title || (tops.length === 1 && heads.length > 1 && heads[0] === tops[0] ? tops[0].label : '');
  const entries = heads.filter((h) => !(tops.length === 1 && heads.length > 1 && h === tops[0] && h === heads[0]));
  const base = entries.length ? Math.min(...entries.map((h) => h.level)) : 1;
  const toc = entries.map((h) => ({ label: h.label, at: h.at, depth: h.level - base }));
  const tables = figures.concat(findTextTables(text)).sort((a, b) => a.at - b.at);
  return {
    text, toc, pages: [], figures: tables, images: [],
    title, author: meta.author || meta.authors || '', publisher: meta.publisher || '',
    year: ((meta.year || meta.date || '').match(/\b\d{4}\b/) || [''])[0],
  };
}
