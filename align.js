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
export async function indexMp3(file, onProgress) {
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
export function byteRange(index, t0, t1, fileSize) {
  const { times, bytes } = index;
  let a = 0;
  while (a + 1 < times.length && times[a + 1] <= t0) a++;
  let b = a;
  while (b < times.length && times[b] < t1) b++;
  return { start: bytes[a], end: b < bytes.length ? bytes[b] : fileSize, startTime: times[a] };
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
