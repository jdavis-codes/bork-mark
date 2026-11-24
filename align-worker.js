// Runs Whisper off the main thread so the page stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

let asr = null;
let loadedKey = '';

self.onmessage = async (e) => {
  const { id, audio, model, device } = e.data;
  try {
    const key = model + '|' + device;
    let loadMs = 0;
    if (key !== loadedKey) {
      const t0 = performance.now();
      asr = null; loadedKey = '';
      asr = await pipeline('automatic-speech-recognition', model, {
        device,
        dtype: device === 'webgpu'
          ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress') {
            self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
          }
        },
      });
      loadedKey = key;
      loadMs = performance.now() - t0;
    }
    self.postMessage({ type: 'stage', stage: 'transcribing' });
    const t1 = performance.now();
    const out = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: 'word',
    });
    self.postMessage({ type: 'done', id, text: out.text, chunks: out.chunks || [], loadMs, runMs: performance.now() - t1 });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
