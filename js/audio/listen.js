// From a time in the audiobook to the words spoken there: decoding a clip, resampling it for
// Whisper, and transcribing it.

import { tokenize } from '../text/book.js';

// Decodes compressed audio. The browser resamples it to `rate` as it decodes,
// so asking for 16 kHz (what Whisper wants) never holds the clip at full
// quality: a minute of stereo is about 8 MB instead of 21.
export async function decode(arrayBuffer, rate = 44100) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, rate);
  return await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej);
    if (p && p.catch) p.catch(rej);
  });
}

// Mix to mono and average down to 16 kHz, which is what Whisper expects.
// One pass per channel straight into the output, with no full-length mono
// copy: this runs on the main thread while the book plays, so it is kept lean.
export function to16kMono(ab) {
  const n = ab.length, ch = ab.numberOfChannels, ratio = ab.sampleRate / 16000;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let c = 0; c < ch; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < out.length; i++) {
      const s = Math.floor(i * ratio), e = Math.max(s + 1, Math.min(n, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let k = s; k < e; k++) sum += d[k];
      out[i] += sum / ((e - s) * ch);
    }
  }
  return out;
}

// ---------- one bookmark, end to end ----------
// Cuts the audio around time T, transcribes it with the supplied function and
// returns the spoken words plus the index of the word at T.
export async function transcribeAround(source, T, before, after, transcribe, onStage = () => {}) {
  onStage('cutting the audio clip');
  const c = await source.clip(T - before, T + after);
  onStage('decoding the audio clip');
  const pcm = to16kMono(await decode(c.buffer, 16000));   // already 16 kHz: this only mixes to mono
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
