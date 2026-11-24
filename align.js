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

  for (const trak of boxes(v, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(v, trak, 'mdia');
    const hdlr = child(v, mdia, 'hdlr');
    if (!hdlr || fourcc(v, hdlr.start + 8) !== 'soun') continue;
    const mdhd = child(v, mdia, 'mdhd');
    const timescale = v.getUint32(mdhd.start + (v.getUint8(mdhd.start) === 1 ? 20 : 12));
    const stbl = child(v, child(v, mdia, 'minf'), 'stbl');
    const stsd = child(v, stbl, 'stsd');
    const entry = boxes(v, stsd.start + 8, stsd.end)[0];
    if (!entry || entry.type !== 'mp4a') throw new Error('audio codec ' + (entry ? entry.type : '?') + ' is not supported');
    let esds = boxes(v, entry.start + 28, entry.end).find((b) => b.type === 'esds');
    if (!esds) throw new Error('missing AAC configuration');
    const cfg = parseEsds(v, esds);

    const stsz = child(v, stbl, 'stsz'), stsc = child(v, stbl, 'stsc'), stts = child(v, stbl, 'stts');
    const stco = child(v, stbl, 'stco'), co64 = child(v, stbl, 'co64');
    if (!stsz || !stsc || !stts || !(stco || co64)) throw new Error('incomplete sample tables');
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
    const sampleAt = (t) => {
      let ticks = t * timescale, idx = 0;
      for (const r of runs) {
        if (!r.delta || ticks < r.count * r.delta) return Math.min(n - 1, idx + (r.delta ? Math.floor(ticks / r.delta) : 0));
        ticks -= r.count * r.delta; idx += r.count;
      }
      return n - 1;
    };
    const timeOf = (i) => {
      let ticks = 0;
      for (const r of runs) {
        if (i < r.count) return (ticks + i * r.delta) / timescale;
        ticks += r.count * r.delta; i -= r.count;
      }
      return ticks / timescale;
    };

    return {
      kind: cfg.mp3 ? 'MP3 in MP4' : 'AAC', duration: total / timescale,
      // Re-wraps the wanted AAC frames as an ADTS stream, which browsers decode directly.
      async clip(t0, t1) {
        const a = sampleAt(Math.max(0, t0)), b = Math.max(a, sampleAt(t1));
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
        return { buffer: out.buffer, startTime: timeOf(a) };
      },
    };
  }
  throw new Error('no audio track found');
}

// Opens an audio file for clipping: {kind, duration, clip(t0, t1)}.
// clip() resolves to {buffer, startTime}: a small decodable piece of the file.
export async function openAudio(file, onProgress) {
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  if (head.byteLength >= 12 && fourcc(head, 4) === 'ftyp') return await indexMp4(file);
  const idx = await indexMp3(file, onProgress);
  if (idx.frames < 20) throw new Error('not an MP3, M4B or M4A file');
  return {
    kind: 'MP3', duration: idx.duration,
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

function htmlToText(markup) {
  let doc = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(markup, 'text/html');
  const body = doc.querySelector('body') || doc.documentElement;
  body.querySelectorAll('script,style').forEach((n) => n.remove());
  body.querySelectorAll(BLOCKS).forEach((n) => n.appendChild(doc.createTextNode('\n')));
  return body.textContent.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export async function readBook(file) {
  if (!/\.epub$/i.test(file.name)) return await file.text();
  const { unzipSync, strFromU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js');
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const read = (name) => {
    if (!zip[name]) throw new Error('EPUB is missing ' + name);
    return strFromU8(zip[name]);
  };
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const opfPath = xml(read('META-INF/container.xml')).querySelector('rootfile').getAttribute('full-path');
  const opf = xml(read(opfPath));
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const hrefs = {};
  opf.querySelectorAll('manifest > item').forEach((it) => { hrefs[it.getAttribute('id')] = it.getAttribute('href'); });
  const parts = [];
  opf.querySelectorAll('spine > itemref').forEach((ref) => {
    const href = hrefs[ref.getAttribute('idref')];
    if (!href) return;
    const path = dir + decodeURIComponent(href.split('#')[0]);
    if (zip[path]) parts.push(htmlToText(strFromU8(zip[path])));
  });
  if (!parts.length) throw new Error('No readable chapters found in EPUB');
  return parts.join('\n\n');
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
