// Reading audiobook files without decoding them: an MP3 frame index and its ID3 tag, MP4 / M4B
// boxes (duration, chapters, tags, cover; AAC or Opus audio), and cutting out a short clip at any time.

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

// ---------- MP3 tags (ID3v2.2 to 2.4) ----------
// The book's title, author and cover picture. An audiobook in MP3 parts names
// each part in the title ("… - Track 002"), so the album is taken as the title.
const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
// Removes the 0x00 that unsynchronisation puts after every 0xFF.
function resync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0) i++; }
  return out.subarray(0, n);
}
// Where a string in this encoding ends (its terminator), from i.
function textEnd(b, i, enc) {
  if (enc === 1 || enc === 2) { while (i + 1 < b.length && (b[i] || b[i + 1])) i += 2; return i; }
  while (i < b.length && b[i]) i++;
  return i;
}
function text(b, enc) {
  const label = enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(label).decode(b).replace(/\0[\s\S]*$/, '').trim();
}
const V22 = { TT2: 'TIT2', TAL: 'TALB', TP1: 'TPE1', TP2: 'TPE2' };   // ID3v2.2's three-letter names
async function readId3(file) {
  const tags = { title: '', author: '', cover: null };
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return tags;
  const ver = head[3], flags = head[5], size = syncsafe(head, 6);
  if (ver < 2 || ver > 4 || size > (64 << 20)) return tags;
  let b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  if ((flags & 0x80) && ver < 4) b = resync(b);
  let p = 0;
  if ((flags & 0x40) && ver > 2) p = ver === 4 ? syncsafe(b, 0) : 4 + ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
  const idLen = ver === 2 ? 3 : 4, headLen = ver === 2 ? 6 : 10;
  const found = {};
  let picture = null;
  while (p + headLen <= b.length && b[p]) {
    const id = String.fromCharCode(...b.subarray(p, p + idLen));
    const len = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
      : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    if (!/^[A-Z0-9]+$/.test(id) || len <= 0 || p + headLen + len > b.length) break;
    let body = b.subarray(p + headLen, p + headLen + len);
    if (ver === 4) {
      const fmt = b[p + 9];
      if (fmt & 0x0c) { p += headLen + len; continue; }   // compressed or encrypted: skip
      if (fmt & 0x01) body = body.subarray(4);             // a data-length field comes first
      if ((fmt & 0x02) || (flags & 0x80)) body = resync(body);
    }
    p += headLen + len;
    const enc = body[0];
    const name = V22[id] || id;
    if (/^(TIT2|TALB|TPE1|TPE2)$/.test(name)) found[name] = found[name] || text(body.subarray(1), enc);
    else if ((id === 'APIC' || id === 'PIC') && body.length > 8) {
      let i = 1, mime;
      if (id === 'PIC') { mime = String.fromCharCode(...body.subarray(1, 4)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'; i = 4; }
      else { const e = textEnd(body, 1, 0); mime = String.fromCharCode(...body.subarray(1, e)).toLowerCase(); i = e + 1; }
      const kind = body[i++];
      i = textEnd(body, i, enc) + (enc === 1 || enc === 2 ? 2 : 1);   // past the description
      if (i >= body.length) continue;
      if (!/^image\//.test(mime)) mime = body[i] === 0x89 ? 'image/png' : 'image/jpeg';
      // the front cover (type 3) wins over any other picture
      if (!picture || (kind === 3 && picture.kind !== 3)) picture = { kind, blob: new Blob([body.slice(i)], { type: mime }) };
    }
  }
  tags.title = found.TALB || found.TIT2 || '';
  tags.author = found.TPE1 || found.TPE2 || '';
  tags.cover = picture ? picture.blob : null;
  return tags;
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

// ---------- Opus in MP4, re-wrapped as Ogg ----------
// The dOps box holds what Ogg's OpusHead holds, big-endian instead of little.
function parseDops(v, d) {
  const channels = v.getUint8(d.start + 1), family = v.getUint8(d.start + 9);
  const head = new Uint8Array(19 + (family ? 2 + channels : 0));
  const hv = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);   // "OpusHead", version 1
  const preSkip = v.getUint16(d.start + 2);
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, v.getUint32(d.start + 4), true);    // the original sample rate, for information
  hv.setInt16(16, v.getInt16(d.start + 8), true);      // output gain
  head[18] = family;
  for (let i = 0; i < (family ? 2 + channels : 0); i++) head[19 + i] = v.getUint8(d.start + 10 + i);
  return { head, preSkip };
}

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }

// One Ogg page holding whole packets.
function oggPage(packets, granule, seq, flags) {
  const lacing = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + body), pv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);   // "OggS"
  pv.setUint32(6, granule % 4294967296, true); pv.setUint32(10, Math.floor(granule / 4294967296), true);
  pv.setUint32(14, 0x426f726b, true);              // stream serial number: "Bork"
  pv.setUint32(18, seq, true);
  page[26] = lacing.length; page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
  pv.setUint32(22, crc, true);
  return page;
}

// Samples a..b (their bytes in src, which starts at file offset `from`) as an Ogg Opus stream.
// Only a clip from the very start keeps the encoder's pre-skip; later clips start on their first sample.
function oggOpus(opus, audio, a, b, src, from) {
  const head = opus.head.slice();
  const skip = a === 0 ? opus.preSkip : 0;
  new DataView(head.buffer).setUint16(10, skip, true);
  const vendor = new TextEncoder().encode('Bork Mark');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4), tv = new DataView(tags.buffer);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);   // "OpusTags", no comments
  tv.setUint32(8, vendor.length, true); tags.set(vendor, 12);
  const pages = [oggPage([head], 0, 0, 2), oggPage([tags], 0, 1, 0)];
  let packets = [], lace = 0, granule = 0;   // granule: 48 kHz samples decoded so far, as Ogg counts Opus time
  for (let i = a; i <= b; i++) {
    const p = src.subarray(audio.offsets[i] - from, audio.offsets[i] - from + audio.sizes[i]);
    const need = Math.floor(p.length / 255) + 1;
    if (lace + need > 255) { pages.push(oggPage(packets, granule, pages.length, 0)); packets = []; lace = 0; }
    packets.push(p); lace += need;
    granule = Math.round((audio.timeOf(i + 1) - audio.timeOf(a)) * 48000);
  }
  pages.push(oggPage(packets, granule, pages.length, 4));
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  const startTime = a === 0 ? 0 : Math.max(0, audio.timeOf(a) - opus.preSkip / 48000);
  return { buffer: out.buffer, startTime };
}

async function indexMp4(file, bytes) {
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
  if (!entry || (entry.type !== 'mp4a' && entry.type !== 'Opus')) throw new Error('audio codec ' + (entry ? entry.type : '?') + ' is not supported');
  const { sizes, offsets } = audio;
  let cfg = null, opus = null;
  if (entry.type === 'Opus') {
    const dOps = boxes(v, entry.start + 28, entry.end).find((b) => b.type === 'dOps');
    if (!dOps) throw new Error('missing Opus configuration');
    opus = parseDops(v, dOps);
  } else {
    const esds = boxes(v, entry.start + 28, entry.end).find((b) => b.type === 'esds');
    if (!esds) throw new Error('missing AAC configuration');
    cfg = parseEsds(v, esds);
  }

  let chapters = [], tags = { title: '', author: '', cover: null };
  try { chapters = await readChapters(file, v, moov, tracks, audio); } catch (e) { /* chapters are optional */ }
  try { tags = readTags(v, moov); } catch (e) { /* tags are optional */ }

  return {
    kind: opus ? 'Opus' : cfg.mp3 ? 'MP3 in MP4' : 'AAC', duration: audio.duration, chapters, tags,
    // Re-wraps the wanted frames as a stream browsers decode directly: ADTS for AAC, Ogg for Opus.
    async clip(t0, t1) {
      const a = audio.sampleAt(Math.max(0, t0)), b = Math.max(a, audio.sampleAt(t1));
      const from = offsets[a], to = offsets[b] + sizes[b];
      const src = new Uint8Array(await bytes(from, to));
      if (opus) return oggOpus(opus, audio, a, b, src, from);
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
// reopen(), if given, fetches the file again: on iOS a stored file read earlier can
// stop being readable ("The object can not be found here"), so a clip that fails
// to read tries once more with a fresh copy.
export async function openAudio(file, onProgress, reopen) {
  let current = file;
  const bytes = async (a, b) => {
    try { return await current.slice(a, b).arrayBuffer(); } catch (err) {
      if (!reopen) throw err;
      const again = await reopen();
      if (!again) throw new Error('the audio file is no longer on this device');
      current = again;
      return await current.slice(a, b).arrayBuffer();
    }
  };
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  if (head.byteLength >= 12 && fourcc(head, 4) === 'ftyp') return await indexMp4(file, bytes);
  const idx = await indexMp3(file, onProgress);
  if (idx.frames < 20) throw new Error('not an MP3, M4B or M4A file');
  let tags = { title: '', author: '', cover: null };
  try { tags = await readId3(file); } catch (err) { /* a broken tag only loses the title and cover */ }
  return {
    kind: 'MP3', duration: idx.duration, chapters: [], tags,
    async clip(t0, t1) {
      const r = byteRange(idx, Math.max(0, t0), t1, file.size);
      return { buffer: await bytes(r.start, r.end), startTime: r.startTime };
    },
  };
}
