// The EPUB reader.

import { entryAt } from '../text/book.js';
import { findTextTables, unwrapLines } from '../text/cleanup.js';

const BLOCKS = 'p,div,h1,h2,h3,h4,h5,h6,li,br,blockquote,tr,section,dt,dd';
const MARK_OPEN = '', MARK_CLOSE = '';   // private-use characters that never occur in books
const marker = (kind, label) => MARK_OPEN + kind + String(label).replace(/[\s]+/g, ' ').trim() + MARK_CLOSE;
const epubType = (n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '') + ' ' + (n.getAttribute('role') || '');

// Text of one chapter file. `anchors` lists places in this file that the
// table of contents or page list points at; a marker is left at each so its
// position in the finished text can be found.
function htmlToText(markup, anchors = [], ctx = null) {
  let doc = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(markup, 'text/html');
  const body = doc.querySelector('body') || doc.documentElement;
  body.querySelectorAll('script,style').forEach((n) => n.remove());
  // Line breaks typed inside a paragraph in the file are only spacing, not
  // lines of the book, so flatten them (except in preformatted text).
  const walker = doc.createTreeWalker(body, 4 /* text nodes */);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const n of textNodes) if (!n.parentNode.closest || !n.parentNode.closest('pre')) n.nodeValue = n.nodeValue.replace(/\s+/g, ' ');
  const listed = new Set(anchors.filter((a) => a.kind === 'P').map((a) => a.id));
  // Print page breaks marked in the text itself.
  for (const n of body.querySelectorAll('*')) {
    if (!/pagebreak/.test(epubType(n))) continue;
    const label = n.getAttribute('title') || n.getAttribute('aria-label') || n.textContent.trim() || (n.id.match(/\d+$/) || [''])[0];
    n.textContent = '';
    if (label && !listed.has(n.id)) n.parentNode.insertBefore(doc.createTextNode(marker('P', label)), n);
  }
  // Pictures and tables: a marker is left where each one sits, and what it is
  // goes into ctx.figs.
  if (ctx) {
    const seen = new Set();
    const add = (node, fig) => { ctx.figs.push(fig); node.parentNode.insertBefore(doc.createTextNode(marker('F', ctx.figs.length - 1)), node); };
    const srcOf = (img) => resolveHref(dirOf(ctx.path), img.getAttribute('src') || img.getAttribute('href')
      || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '')[0];
    const tableFig = (table, cap) => {
      const rows = Array.from(table.querySelectorAll('tr')).slice(0, 60)
        .map((tr) => Array.from(tr.children).slice(0, 12).map((c) => clean(c.textContent).slice(0, 200)));
      // one row or one column is page layout, not data
      return rows.length > 1 && rows.some((r) => r.length > 1) ? { kind: 'table', cap: cap || clean((table.querySelector('caption') || {}).textContent), rows } : null;
    };
    for (const fig of body.querySelectorAll('figure')) {
      const img = fig.querySelector('img, image'), table = fig.querySelector('table');
      const cap = clean((fig.querySelector('figcaption') || {}).textContent);
      fig.querySelectorAll('img, image, table').forEach((n) => seen.add(n));
      if (img && srcOf(img)) add(fig, { kind: 'image', src: srcOf(img), cap: cap || clean(img.getAttribute('alt')) });
      else if (table && tableFig(table, cap)) add(fig, tableFig(table, cap));
    }
    for (const img of body.querySelectorAll('img, image')) {
      if (!seen.has(img) && srcOf(img)) add(img, { kind: 'image', src: srcOf(img), cap: clean(img.getAttribute('alt') || img.getAttribute('title')) });
    }
    for (const table of body.querySelectorAll('table')) {
      if (!seen.has(table) && !table.parentNode.closest('table') && tableFig(table, '')) add(table, tableFig(table, ''));
    }
  }
  for (const a of anchors) {
    let target = null;
    if (a.id) {
      target = doc.getElementById(a.id);
      if (!target) for (const n of body.querySelectorAll('[id],[name]')) if (n.id === a.id || n.getAttribute('name') === a.id) { target = n; break; }
    }
    const text = doc.createTextNode(marker(a.kind, a.label));
    if (target && target.parentNode) target.parentNode.insertBefore(text, target); else body.insertBefore(text, body.firstChild);
  }
  body.querySelectorAll(BLOCKS).forEach((n) => n.appendChild(doc.createTextNode('\n')));
  return body.textContent.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// "OEBPS/text/" + "../nav.xhtml#x" -> ["OEBPS/nav.xhtml", "x"]
function resolveHref(baseDir, href) {
  const [path, id = ''] = href.split('#');
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of decodeURIComponent(path).split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return [path ? parts.join('/') : null, decodeURIComponent(id)];
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const byTag = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

// Reads an EPUB into the common book shape (see index.js). Pages are the print
// edition's page numbers when the EPUB records them.
export async function readEpub(file) {
  const { unzipSync, strFromU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js');
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const read = (name) => {
    if (!zip[name]) throw new Error('EPUB is missing ' + name);
    return strFromU8(zip[name]);
  };
  const xml = (str) => new DOMParser().parseFromString(str, 'application/xml');
  const opfPath = xml(read('META-INF/container.xml')).querySelector('rootfile').getAttribute('full-path');
  const opf = xml(read(opfPath));
  const dir = dirOf(opfPath);
  const items = {};
  let navPath = null;
  byTag(opf, 'item').forEach((it) => {
    const path = resolveHref(dir, it.getAttribute('href') || '')[0];
    items[it.getAttribute('id')] = path;
    if (/\bnav\b/.test(it.getAttribute('properties') || '')) navPath = path;
  });
  const spineEl = byTag(opf, 'spine')[0];
  const spine = byTag(opf, 'itemref').map((r) => items[r.getAttribute('idref')]).filter((path) => path && zip[path]);
  if (!spine.length) throw new Error('No readable chapters found in EPUB');

  // Where the contents list and page list point: file -> [{id, kind, label}].
  const anchors = new Map();
  const note = (base, href, kind, label) => {
    if (!href || !clean(label)) return;
    const [path, id] = resolveHref(base, href);
    if (!path) return;
    if (!anchors.has(path)) anchors.set(path, []);
    anchors.get(path).push({ id, kind, label: clean(label) });
  };
  try {
    const ncxPath = spineEl && items[spineEl.getAttribute('toc')];
    if (navPath && zip[navPath]) {          // EPUB 3
      const nav = new DOMParser().parseFromString(read(navPath), 'application/xhtml+xml');
      for (const n of byTag(nav, 'nav')) {
        const kind = /page-list/.test(epubType(n)) ? 'P' : /\btoc\b/.test(epubType(n)) ? 'T' : null;
        if (kind) byTag(n, 'a').forEach((a) => note(dirOf(navPath), a.getAttribute('href'), kind, a.textContent));
      }
    }
    if (ncxPath && zip[ncxPath]) {          // EPUB 2, and page lists some EPUB 3 files keep here
      const ncx = xml(read(ncxPath));
      const have = (kind) => [...anchors.values()].some((list) => list.some((a) => a.kind === kind));
      const add = (tag, kind) => byTag(ncx, tag).forEach((pt) => {
        const label = byTag(pt, 'text')[0], content = byTag(pt, 'content')[0];
        if (label && content) note(dirOf(ncxPath), content.getAttribute('src'), kind, label.textContent);
      });
      if (!have('T')) add('navPoint', 'T');
      if (!have('P')) add('pageTarget', 'P');
    }
  } catch (e) { /* a broken contents list should not stop the text loading */ }

  const figs = [];
  const raw = spine.map((path) => htmlToText(strFromU8(zip[path]), anchors.get(path), { path, figs })).join('\n\n');
  // Take the markers back out, noting where each one was.
  const toc = [], pages = [], figures = [], images = [], imageAt = new Map();
  let text = '', last = 0, imageBytes = 0;
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const re = new RegExp(MARK_OPEN + '([PTF])([^' + MARK_CLOSE + ']*)' + MARK_CLOSE, 'g');
  for (let m; (m = re.exec(raw));) {
    text += raw.slice(last, m.index); last = re.lastIndex;
    if (raw[last] === ' ' && (!text || text.endsWith('\n'))) last++;   // no stray space at the start of a line
    if (m[1] !== 'F') { (m[1] === 'T' ? toc : pages).push({ label: m[2], at: text.length }); continue; }
    const fig = figs[Number(m[2])];
    if (!fig) continue;
    if (fig.kind === 'table') { figures.push({ at: text.length, kind: 'table', cap: fig.cap, rows: fig.rows }); continue; }
    // Keep real pictures: skip ornaments and rules (tiny files), anything huge,
    // and stop once the book's pictures pass 60 MB in all.
    const bytes = zip[fig.src], type = TYPES[(fig.src.split('.').pop() || '').toLowerCase()];
    if (!bytes || !type || bytes.length < 4096 || bytes.length > 6 << 20) continue;
    if (/(^|[\/_-])(cover|logo|titlepage)[^\/]*$/i.test(fig.src)) continue;   // not part of the text
    if (!imageAt.has(fig.src)) {
      if (imageBytes + bytes.length > 60 << 20) continue;
      imageBytes += bytes.length;
      imageAt.set(fig.src, images.length);
      images.push(new Blob([bytes], { type }));
    }
    figures.push({ at: text.length, kind: 'image', cap: fig.cap, img: imageAt.get(fig.src) });
  }
  text = unwrapLines(text + raw.slice(last));
  figures.push(...findTextTables(text));
  figures.sort((a, b) => a.at - b.at);
  const dedupe = (list) => list.filter((x, k) => k === 0 || x.label !== list[k - 1].label);
  toc.sort((a, b) => a.at - b.at); pages.sort((a, b) => a.at - b.at);
  // Drop pictures that are publisher furniture rather than part of the book:
  // anything on the cover, title, copyright or sign-up pages, and logos.
  const FURNITURE = /^(cover|title ?page|half ?title|copyright|imprint|colophon|contents|about( the)? (author|publisher)|also by|newsletter|sign ?up)/i;
  const BADGE = /logo|sign ?up|newsletter|instagram|facebook|twitter|pinterest/i;
  const sorted = dedupe(toc);
  const kept = figures.filter((f) => {
    if (f.kind !== 'image') return true;
    const section = entryAt(sorted, f.at);
    return !(section && FURNITURE.test(section.label)) && !BADGE.test(f.cap || '');
  });
  for (const f of kept) if (/^image$|\.(jpe?g|png|gif|svg|webp)$/i.test(f.cap || '')) f.cap = '';   // a file name is not a caption
  figures.length = 0; figures.push(...kept);
  const meta = byTag(opf, 'metadata')[0] || opf;
  return {
    text, toc: dedupe(toc), pages: dedupe(pages), figures, images,
    title: clean((byTag(meta, 'title')[0] || {}).textContent),
    author: byTag(meta, 'creator').map((c) => clean(c.textContent)).filter(Boolean).join(', '),
    publisher: clean((byTag(meta, 'publisher')[0] || {}).textContent),
    // The date an EPUB records is usually that edition's, not the first printing's.
    year: (clean((byTag(meta, 'date')[0] || {}).textContent).match(/\b\d{4}\b/) || [''])[0],
  };
}
