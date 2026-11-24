// Pure helpers for the alignment test: MP3 indexing, resampling, EPUB text
// extraction and fuzzy matching of a transcript against the book text.

// ---------- MP3 frame index ----------
const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR_V1 = [44100, 48000, 32000];

// Returns {size, seconds} for a valid MPEG Layer III frame header, else null.
function parseFrame(b0, b1, b2) {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const ver = (b1 >> 3) & 3;            // 0 = MPEG2.5, 2 = MPEG2, 3 = MPEG1
  if (ver === 1 || ((b1 >> 1) & 3) !== 1) return null;
  const bi = b2 >> 4, si = (b2 >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const v1 = ver === 3;
  const rate = SR_V1[si] / (v1 ? 1 : ver === 2 ? 2 : 4);
  const kbps = (v1 ? BR_V1 : BR_V2)[bi];
  const samples = v1 ? 1152 : 576;
  const size = Math.floor((samples / 8) * kbps * 1000 / rate) + ((b2 >> 1) & 1);
  return { size, seconds: samples / rate };
}

// Walks every frame once and records a (time, byte offset) pair about once a
// second, so any time range maps to an exact byte range even for VBR files.
async function indexMp3(file, onProgress) {
  const CHUNK = 4 << 20;
  let pos = 0;
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    pos = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
  }
  const times = [], bytes = [];
  let t = 0, frames = 0, nextMark = 0, synced = false;
  let buf = new Uint8Array(0), bufStart = 0;
  while (pos + 4 <= file.size) {
    if (pos < bufStart || pos + 4 > bufStart + buf.length) {
      buf = new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer());
      bufStart = pos;
      if (onProgress) onProgress(pos / file.size);
      if (buf.length < 4) break;
    }
    const i = pos - bufStart;
    const f = parseFrame(buf[i], buf[i + 1], buf[i + 2]);
    if (f && !synced) {
      // After junk, only trust a header if another valid one follows it.
      const j = i + f.size;
      if (j + 3 <= buf.length && !parseFrame(buf[j], buf[j + 1], buf[j + 2])) { pos++; continue; }
    }
    if (!f) { synced = false; pos++; continue; }
    synced = true;
    if (t >= nextMark) { times.push(t); bytes.push(pos); nextMark = t + 1; }
    t += f.seconds; pos += f.size; frames++;
  }
  return { times, bytes, duration: t, frames };
}

// Byte range covering [t0, t1], plus the real start time of that range.
function byteRange(index, t0, t1, fileSize) {
  const { times, bytes } = index;
  let a = 0;
  while (a + 1 < times.length && times[a + 1] <= t0) a++;
  let b = a;
  while (b < times.length && times[b] < t1) b++;
  return { start: bytes[a], end: b < bytes.length ? bytes[b] : fileSize, startTime: times[a] };
}

// ---------- MP4 / M4B / M4A sample index ----------
const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

// Child boxes of the region [start, end) as {type, start, end} payload spans.
function boxes(v, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p), hdr = 8;
    if (size === 1) { size = v.getUint32(p + 8) * 4294967296 + v.getUint32(p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: fourcc(v, p + 4), start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (v, box, type) => box && boxes(v, box.start, box.end).find((b) => b.type === type);

// Reads an MPEG-4 descriptor header at p: {tag, start, end}.
function descriptor(v, p) {
  const tag = v.getUint8(p++);
  let len = 0, b;
  do { b = v.getUint8(p++); len = (len << 7) | (b & 0x7f); } while (b & 0x80);
  return { tag, start: p, end: p + len };
}

// Pulls what an ADTS header needs out of the track's esds box.
function parseEsds(v, esds) {
  let d = descriptor(v, esds.start + 4);
  if (d.tag !== 3) throw new Error('unexpected audio description');
  let p = d.start + 2;
  const flags = v.getUint8(p++);
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + v.getUint8(p);
  if (flags & 0x20) p += 2;
  d = descriptor(v, p);
  if (d.tag !== 4) throw new Error('unexpected audio description');
  const oti = v.getUint8(d.start);
  if (oti === 0x69 || oti === 0x6b) return { mp3: true };
  if (oti !== 0x40 && oti !== 0x66 && oti !== 0x67 && oti !== 0x68) throw new Error('audio codec is not AAC');
  d = descriptor(v, d.start + 13);
  if (d.tag !== 5 || d.end - d.start < 2) throw new Error('missing AAC configuration');
  const bits = v.getUint16(d.start);
  let aot = bits >> 11;
  const freqIdx = (bits >> 7) & 15, channels = (bits >> 3) & 15;
  // HE-AAC is signalled on top of an AAC-LC core; the core decodes on its own.
  if (aot === 5 || aot === 29) aot = 2;
  if (aot < 1 || aot > 4 || freqIdx > 12 || channels === 0) throw new Error('unsupported AAC variant');
  return { mp3: false, aot, freqIdx, channels };
}

// Sample tables for one track: where each sample sits in the file and when.
function readTrack(v, trak) {
  const mdia = child(v, trak, 'mdia');
  const hdlr = child(v, mdia, 'hdlr'), mdhd = child(v, mdia, 'mdhd'), tkhd = child(v, trak, 'tkhd');
  if (!hdlr || !mdhd || !tkhd) return null;
  const stbl = child(v, child(v, mdia, 'minf'), 'stbl');
  const t = {
    id: v.getUint32(tkhd.start + (v.getUint8(tkhd.start) === 1 ? 20 : 12)),
    handler: fourcc(v, hdlr.start + 8),
    timescale: v.getUint32(mdhd.start + (v.getUint8(mdhd.start) === 1 ? 20 : 12)),
    stbl, chapterRefs: [],
  };
  const chap = child(v, child(v, trak, 'tref'), 'chap');
  if (chap) for (let p = chap.start; p + 4 <= chap.end; p += 4) t.chapterRefs.push(v.getUint32(p));

  const stsz = child(v, stbl, 'stsz'), stsc = child(v, stbl, 'stsc'), stts = child(v, stbl, 'stts');
  const stco = child(v, stbl, 'stco'), co64 = child(v, stbl, 'co64');
  if (!stsz || !stsc || !stts || !(stco || co64)) return t;
  const fixed = v.getUint32(stsz.start + 4), n = v.getUint32(stsz.start + 8);
  const sizes = new Uint32Array(n);
  for (let i = 0; i < n; i++) sizes[i] = fixed || v.getUint32(stsz.start + 12 + i * 4);

  const cb = stco || co64, nChunks = v.getUint32(cb.start + 4);
  const chunkOff = (c) => stco ? v.getUint32(cb.start + 8 + c * 4)
    : v.getUint32(cb.start + 8 + c * 8) * 4294967296 + v.getUint32(cb.start + 12 + c * 8);
  const offsets = new Float64Array(n);
  const nRuns = v.getUint32(stsc.start + 4);
  let s = 0;
  for (let r = 0; r < nRuns && s < n; r++) {
    const first = v.getUint32(stsc.start + 8 + r * 12) - 1;
    const per = v.getUint32(stsc.start + 12 + r * 12);
    const next = r + 1 < nRuns ? v.getUint32(stsc.start + 8 + (r + 1) * 12) - 1 : nChunks;
    for (let c = first; c < next && s < n; c++) {
      let off = chunkOff(c);
      for (let k = 0; k < per && s < n; k++) { offsets[s] = off; off += sizes[s]; s++; }
    }
  }

  // Time table: runs of samples that share one duration.
  const runs = [];
  let total = 0;
  for (let i = 0, c = v.getUint32(stts.start + 4); i < c; i++) {
    const count = v.getUint32(stts.start + 8 + i * 8), delta = v.getUint32(stts.start + 12 + i * 8);
    runs.push({ count, delta }); total += count * delta;
  }
  const ts = t.timescale;
  t.n = n; t.sizes = sizes; t.offsets = offsets; t.duration = total / ts;
  t.sampleAt = (time) => {
    let ticks = time * ts, idx = 0;
    for (const r of runs) {
      if (!r.delta || ticks < r.count * r.delta) return Math.min(n - 1, idx + (r.delta ? Math.floor(ticks / r.delta) : 0));
      ticks -= r.count * r.delta; idx += r.count;
    }
    return n - 1;
  };
  t.timeOf = (i) => {
    let ticks = 0;
    for (const r of runs) {
      if (i < r.count) return (ticks + i * r.delta) / ts;
      ticks += r.count * r.delta; i -= r.count;
    }
    return ticks / ts;
  };
  return t;
}

const utf8 = new TextDecoder('utf-8');

// Chapters live in one of two places: a "chpl" list (Nero style), or a text
// track whose samples are the titles and whose sample times are the starts.
async function readChapters(file, v, moov, tracks, audio) {
  const out = [];
  const textTrack = tracks.find((t) => audio.chapterRefs.includes(t.id) && t.n)
    || (audio.chapterRefs.length ? null : tracks.find((t) => t.handler === 'text' && t.n));
  if (textTrack) {
    const t = textTrack;
    for (let i = 0; i < t.n && i < 2000; i++) {
      const b = new Uint8Array(await file.slice(t.offsets[i], t.offsets[i] + t.sizes[i]).arrayBuffer());
      if (b.length < 2) continue;
      const len = Math.min((b[0] << 8) | b[1], b.length - 2);
      const raw = b.subarray(2, 2 + len);
      const title = raw[0] === 0xfe && raw[1] === 0xff ? new TextDecoder('utf-16be').decode(raw.subarray(2)) : utf8.decode(raw);
      out.push({ start: t.timeOf(i), title: title.trim() });
    }
  }
  const chpl = child(v, child(v, moov, 'udta'), 'chpl');
  if (!out.length && chpl) {
    let p = chpl.start + 4 + (v.getUint8(chpl.start) ? 4 : 0);
    const count = v.getUint8(p++);
    for (let i = 0; i < count && p + 9 <= chpl.end; i++) {
      const start = (v.getUint32(p) * 4294967296 + v.getUint32(p + 4)) / 1e7;
      const len = v.getUint8(p + 8);
      out.push({ start, title: utf8.decode(new Uint8Array(v.buffer, v.byteOffset + p + 9, len)).trim() });
      p += 9 + len;
    }
  }
  out.sort((a, b) => a.start - b.start);
  out.forEach((c, i) => { if (!c.title) c.title = 'Chapter ' + (i + 1); });
  return out;
}

// Title, author and cover from the iTunes-style tag list.
function readTags(v, moov) {
  const tags = { title: '', author: '', cover: null };
  const meta = child(v, child(v, moov, 'udta'), 'meta');
  if (!meta) return tags;
  const ilst = boxes(v, meta.start + 4, meta.end).find((b) => b.type === 'ilst');
  if (!ilst) return tags;
  for (const item of boxes(v, ilst.start, ilst.end)) {
    const data = child(v, item, 'data');
    if (!data || data.end - data.start < 8) continue;
    const type = v.getUint32(data.start) & 0xffffff;
    const bytes = new Uint8Array(v.buffer, v.byteOffset + data.start + 8, data.end - data.start - 8);
    if (item.type === '©nam') tags.title = utf8.decode(bytes);
    else if (item.type === '©ART' || (item.type === 'aART' && !tags.author)) tags.author = utf8.decode(bytes);
    else if (item.type === 'covr' && !tags.cover) tags.cover = new Blob([bytes.slice()], { type: type === 14 ? 'image/png' : 'image/jpeg' });
  }
  return tags;
}

async function indexMp4(file) {
  // Find the moov box; in audiobooks it is often at the very end of the file.
  let pos = 0, moovAt = -1, moovSize = 0;
  while (pos + 8 <= file.size) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = h.getUint32(0);
    if (size === 1 && h.byteLength >= 16) size = h.getUint32(8) * 4294967296 + h.getUint32(12);
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (fourcc(h, 4) === 'moov') { moovAt = pos; moovSize = size; break; }
    pos += size;
  }
  if (moovAt < 0) throw new Error('no index (moov) found in file');
  const v = new DataView(await file.slice(moovAt, moovAt + moovSize).arrayBuffer());
  const moov = boxes(v, 0, v.byteLength)[0];
  const tracks = boxes(v, moov.start, moov.end).filter((b) => b.type === 'trak').map((b) => readTrack(v, b)).filter(Boolean);

  const audio = tracks.find((t) => t.handler === 'soun');
  if (!audio) throw new Error('no audio track found');
  if (!audio.n) throw new Error('incomplete sample tables');
  const stsd = child(v, audio.stbl, 'stsd');
  const entry = boxes(v, stsd.start + 8, stsd.end)[0];
  if (!entry || entry.type !== 'mp4a') throw new Error('audio codec ' + (entry ? entry.type : '?') + ' is not supported');
  const esds = boxes(v, entry.start + 28, entry.end).find((b) => b.type === 'esds');
  if (!esds) throw new Error('missing AAC configuration');
  const cfg = parseEsds(v, esds);
  const { sizes, offsets } = audio;

  let chapters = [], tags = { title: '', author: '', cover: null };
  try { chapters = await readChapters(file, v, moov, tracks, audio); } catch (e) { /* chapters are optional */ }
  try { tags = readTags(v, moov); } catch (e) { /* tags are optional */ }

  return {
    kind: cfg.mp3 ? 'MP3 in MP4' : 'AAC', duration: audio.duration, chapters, tags,
    // Re-wraps the wanted AAC frames as an ADTS stream, which browsers decode directly.
    async clip(t0, t1) {
      const a = audio.sampleAt(Math.max(0, t0)), b = Math.max(a, audio.sampleAt(t1));
      const from = offsets[a], to = offsets[b] + sizes[b];
      const src = new Uint8Array(await file.slice(from, to).arrayBuffer());
      const hdr = cfg.mp3 ? 0 : 7;
      let len = 0;
      for (let i = a; i <= b; i++) len += sizes[i] + hdr;
      const out = new Uint8Array(len);
      let o = 0;
      for (let i = a; i <= b; i++) {
        const size = sizes[i], rel = offsets[i] - from, full = size + hdr;
        if (hdr) {
          out[o] = 0xff; out[o + 1] = 0xf1;
          out[o + 2] = ((cfg.aot - 1) << 6) | (cfg.freqIdx << 2) | (cfg.channels >> 2);
          out[o + 3] = ((cfg.channels & 3) << 6) | (full >> 11);
          out[o + 4] = (full >> 3) & 0xff;
          out[o + 5] = ((full & 7) << 5) | 0x1f;
          out[o + 6] = 0xfc;
        }
        out.set(src.subarray(rel, rel + size), o + hdr);
        o += full;
      }
      return { buffer: out.buffer, startTime: audio.timeOf(a) };
    },
  };
}

// Opens an audio file for clipping: {kind, duration, chapters, tags, clip(t0, t1)}.
// clip() resolves to {buffer, startTime}: a small decodable piece of the file.
export async function openAudio(file, onProgress) {
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  if (head.byteLength >= 12 && fourcc(head, 4) === 'ftyp') return await indexMp4(file);
  const idx = await indexMp3(file, onProgress);
  if (idx.frames < 20) throw new Error('not an MP3, M4B or M4A file');
  return {
    kind: 'MP3', duration: idx.duration, chapters: [], tags: { title: '', author: '', cover: null },
    async clip(t0, t1) {
      const r = byteRange(idx, Math.max(0, t0), t1, file.size);
      return { buffer: await file.slice(r.start, r.end).arrayBuffer(), startTime: r.startTime };
    },
  };
}

// ---------- audio ----------
export async function decode(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 44100);
  return await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej);
    if (p && p.catch) p.catch(rej);
  });
}

// Mix to mono and average down to 16 kHz, which is what Whisper expects.
export function to16kMono(ab) {
  const n = ab.length, ch = ab.numberOfChannels, ratio = ab.sampleRate / 16000;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const s = Math.floor(i * ratio), e = Math.max(s + 1, Math.min(n, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let k = s; k < e; k++) sum += mono[k];
    out[i] = sum / (e - s);
  }
  return out;
}

// ---------- book text ----------
const BLOCKS = 'p,div,h1,h2,h3,h4,h5,h6,li,br,blockquote,tr,section,dt,dd';
const MARK_OPEN = '', MARK_CLOSE = '';   // private-use characters that never occur in books
const marker = (kind, label) => MARK_OPEN + kind + String(label).replace(/[\s]+/g, ' ').trim() + MARK_CLOSE;
const epubType = (n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '') + ' ' + (n.getAttribute('role') || '');

// Text of one chapter file. `anchors` lists places in this file that the
// table of contents or page list points at; a marker is left at each so its
// position in the finished text can be found.
function htmlToText(markup, anchors = []) {
  let doc = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(markup, 'text/html');
  const body = doc.querySelector('body') || doc.documentElement;
  body.querySelectorAll('script,style').forEach((n) => n.remove());
  const listed = new Set(anchors.filter((a) => a.kind === 'P').map((a) => a.id));
  // Print page breaks marked in the text itself.
  for (const n of body.querySelectorAll('*')) {
    if (!/pagebreak/.test(epubType(n))) continue;
    const label = n.getAttribute('title') || n.getAttribute('aria-label') || n.textContent.trim() || (n.id.match(/\d+$/) || [''])[0];
    n.textContent = '';
    if (label && !listed.has(n.id)) n.parentNode.insertBefore(doc.createTextNode(marker('P', label)), n);
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

// Reads a book into {text, title, author, toc, pages}. `toc` and `pages` are
// lists of {label, at}, where `at` is a character position in `text`; pages
// are the print edition's page numbers when the EPUB records them.
export async function readBook(file) {
  if (!/\.epub$/i.test(file.name)) {
    // Plain text is often hard-wrapped; join lines within a paragraph.
    const text = (await file.text()).replace(/\r/g, '').replace(/([^\n])\n(?!\n)/g, '$1 ');
    return { text, title: '', author: '', toc: [], pages: [] };
  }
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

  const raw = spine.map((path) => htmlToText(strFromU8(zip[path]), anchors.get(path))).join('\n\n');
  // Take the markers back out, noting where each one was.
  const toc = [], pages = [];
  let text = '', last = 0;
  const re = /([PT])([^]*)/g;
  for (let m; (m = re.exec(raw));) {
    text += raw.slice(last, m.index); last = re.lastIndex;
    (m[1] === 'T' ? toc : pages).push({ label: m[2], at: text.length });
  }
  text += raw.slice(last);
  const dedupe = (list) => list.filter((x, k) => k === 0 || x.label !== list[k - 1].label);
  toc.sort((a, b) => a.at - b.at); pages.sort((a, b) => a.at - b.at);
  const meta = byTag(opf, 'metadata')[0] || opf;
  return {
    text, toc: dedupe(toc), pages: dedupe(pages),
    title: clean((byTag(meta, 'title')[0] || {}).textContent),
    author: byTag(meta, 'creator').map((c) => clean(c.textContent)).filter(Boolean).join(', '),
  };
}

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

// ---------- one bookmark, end to end ----------
// Cuts the audio around time T, transcribes it with the supplied function and
// returns the spoken words plus the index of the word at T.
export async function transcribeAround(source, T, before, after, transcribe, onStage = () => {}) {
  onStage('cutting the audio clip');
  const c = await source.clip(T - before, T + after);
  onStage('decoding the audio clip');
  const pcm = to16kMono(await decode(c.buffer));
  onStage('transcribing');
  const out = await transcribe(pcm);
  const words = [], times = [];
  for (const ch of out.chunks) {
    const start = ch.timestamp && ch.timestamp[0] != null ? ch.timestamp[0] : 0;
    for (const w of tokenize(ch.text).words) { words.push(w); times.push(start); }
  }
  let split = times.findIndex((t) => t >= T - c.startTime);
  if (split < 0) split = words.length;
  return { words, split, transcript: out.text.trim() };
}

// Where a transcribed bookmark sits in the book, as word indexes, or null
// when it isn't there.
export function findInBook(book, words, split) {
  const loc = locate(book, words, split);
  if (!loc || !loc.found) return null;
  return { start: loc.start, split: loc.split, end: loc.end, confidence: loc.confidence };
}

const PARA_MAX = 2500;   // most characters taken on either side of the bookmark
const PARA_MIN = 120;    // widen past the requested count until at least this long

// The bookmarked paragraph plus nBefore / nAfter neighbours. Bounded both
// ways, because some books put every line in its own paragraph and others
// have no paragraph breaks at all.
export function paragraphs(book, at, nBefore, nAfter) {
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

// ---------- page numbers from a scanned PDF ----------
// A clean EPUB gives good quotes but usually no page numbers; a scan of the
// print edition has the pages but rough, machine-read text. Used together,
// the quote keeps the EPUB's wording and the scan says which page it is on.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';

// Text of every page of a PDF, plus the PDF's own page labels if it has any.
export async function readPdfPages(file, onProgress = () => {}) {
  const pdfjs = await import(PDFJS + 'pdf.min.mjs');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // A worker script must come from this site, so fetch the library's and wrap it.
    const code = await (await fetch(PDFJS + 'pdf.worker.min.mjs')).text();
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    let labels = null;
    try { labels = await doc.getPageLabels(); } catch (e) { /* optional */ }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : ' ');
      // Rejoin words split across lines ("manu-" / "facturing").
      pages.push(text.replace(/[ \t]+/g, ' ').replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2').trim());
      page.cleanup();
      onProgress(i / doc.numPages);
    }
    if (pages.join('').length < pages.length * 20) throw new Error('this PDF has no text layer (it is images only)');
    // Labels that just count 1, 2, 3… add nothing over the page's position.
    if (labels && labels.every((l, i) => l === String(i + 1))) labels = null;
    return { pages, labels };
  } finally {
    doc.destroy();
  }
}

// Which PDF page (counting from 1) carries printed page number 1, worked out
// from the page numbers printed at the top or bottom of the scanned pages.
export function guessFirstNumbered(pages) {
  const votes = new Map();
  pages.forEach((text, i) => {
    const words = text.split(/\s+/);
    for (const w of new Set([words[0], words[words.length - 1]])) {
      if (!/^\d{1,4}$/.test(w || '')) continue;
      const n = Number(w);
      if (n < 1 || n > pages.length) continue;
      const first = i + 1 - (n - 1);
      votes.set(first, (votes.get(first) || 0) + 1);
    }
  });
  let best = null, count = 0;
  for (const [first, c] of votes) if (c > count) { best = first; count = c; }
  return count >= Math.max(5, pages.length * 0.08) ? best : null;
}

export function buildPageIndex(pages) {
  const starts = [];
  let text = '';
  for (const p of pages) { starts.push(text.length); text += p + '\n\n'; }
  return { book: buildBook(text), starts };
}

// The PDF page (counting from 0) on which the bookmarked point of a quote
// falls, or null when the passage can't be found in the scan.
export function pageOf(index, before, after) {
  const b = tokenize(before).words.slice(-70), a = tokenize(after).words.slice(0, 50);
  const words = b.concat(a);
  if (words.length < 8 || !index.book.starts.length) return null;
  const loc = locate(index.book, words, b.length);
  if (!loc || !loc.found) return null;
  const at = index.book.starts[Math.min(loc.split, index.book.starts.length - 1)];
  let i = 0;
  while (i + 1 < index.starts.length && index.starts[i + 1] <= at) i++;
  return i;
}
