// Runs Whisper off the main thread so the page stays responsive.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

let asr = null;
let loadedKey = '';

// The runtime normally comes from jsDelivr. `alt` switches to a second host,
// for when the first can't be reached (a content blocker, a bad cached copy).
function useAltRuntime() {
  const wasm = env.backends.onnx.wasm, version = env.backends.onnx.versions && env.backends.onnx.versions.web;
  if (!version) return;
  const base = 'https://unpkg.com/onnxruntime-web@' + version + '/dist/';
  const file = (url) => String(url).split('/').pop();
  const paths = wasm.wasmPaths;
  wasm.wasmPaths = paths && typeof paths === 'object'
    ? { mjs: base + file(paths.mjs), wasm: base + file(paths.wasm) } : base;
  env.useWasmCache = false;
}

async function ensure(model, device, alt) {
  const key = model + '|' + device;
  if (key === loadedKey) return 0;
  if (alt) useAltRuntime();
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
  return performance.now() - t0;
}

self.onmessage = async (e) => {
  const { id, audio, model, device, alt } = e.data;
  try {
    const loadMs = await ensure(model, device, alt);
    if (!audio) {   // warm-up request: load the model and report back
      self.postMessage({ type: 'done', id, loadMs });
      return;
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
