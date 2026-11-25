// Speech to text: the Whisper worker, loading its model (with retries), and the status line
// that reports on it.

import { crumb, log } from './log.js';
import { runQueue } from './queue.js';
import { state } from './state.js';
import { $ } from './ui/dom.js';

const MODEL = 'onnx-community/whisper-tiny.en_timestamped';

// ---------- speech-to-text worker ----------
let altRuntime = false;   // fetch the model's runtime from the second host
export let asrWorker = null, asrSeq = 0, modelState = 'idle';   // idle | loading | ready | failed
const asrJobs = new Map();
function asrRequest(pcm) {
  if (!asrWorker) {
    asrWorker = new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' });
    asrWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress' && m.total) {
        setQueueStatus('Downloading the speech model (one time): ' + Math.round(100 * m.loaded / m.total) + '%');
        return;
      }
      const job = asrJobs.get(m.id);
      if (!job) return;
      asrJobs.delete(m.id);
      if (m.type === 'done') job.resolve(m); else job.reject(new Error(m.message));
    };
    asrWorker.onerror = (e) => {
      for (const job of asrJobs.values()) job.reject(new Error(e.message || 'speech model failed to start'));
      asrJobs.clear();
      asrWorker = null; modelState = 'idle';
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++asrSeq;
    asrJobs.set(id, { resolve, reject });
    asrWorker.postMessage({ id, audio: pcm || null, model: MODEL, device: 'wasm', alt: altRuntime }, pcm ? [pcm.buffer] : []);
  });
}
export async function transcribe(pcm) {
  const secs = Math.round(pcm.length / 16000);   // read now: sending the audio to the worker empties it here
  const r = await asrRequest(pcm);
  log('transcribed ' + secs + ' s of audio in ' + (r.runMs / 1000).toFixed(1) + ' s');
  return r;
}

// The model's runtime is a large download from a CDN, and on a phone that
// sometimes fails part-way. A failed start can't be resumed, so each retry
// begins again with a new worker and without any saved copy of the runtime,
// in case the saved copy is what is broken.
const MODEL_RETRIES = [1500, 6000];
async function forgetRuntime() {
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) if (/onnxruntime-web|\.wasm(\?|$)/.test(req.url)) await cache.delete(req);
    }
  } catch (e) { /* no cache storage here */ }
}
async function loadModel() {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await asrRequest(null);
      log('speech model ready in ' + (r.loadMs / 1000).toFixed(1) + ' s' + (attempt ? ', on try ' + (attempt + 1) : '') + (altRuntime ? ', from the second host' : ''));
      return;
    } catch (err) {
      log('speech model failed, try ' + (attempt + 1) + ': ' + err.message + ' | online ' + navigator.onLine
        + ' | service worker ' + !!(navigator.serviceWorker && navigator.serviceWorker.controller));
      if (asrWorker) { asrWorker.terminate(); asrWorker = null; }
      for (const job of asrJobs.values()) job.reject(err);
      asrJobs.clear();
      await forgetRuntime();
      if (attempt >= MODEL_RETRIES.length) { altRuntime = false; throw err; }
      altRuntime = attempt >= 1;   // third try: the other host
      setQueueStatus('The speech model didn’t load. Trying again…');
      await new Promise((r) => setTimeout(r, MODEL_RETRIES[attempt]));
    }
  }
}
// After giving up, try once more whenever the connection or the app comes back.
export function retryModel() { if (modelState === 'failed' && state.books.length) warmModel().then(runQueue, () => {}); }
window.addEventListener('online', retryModel);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryModel(); });

// Loads the speech model ahead of time, so the first bookmark doesn't have
// to do it in the middle of playback.
let warming = null;
export function warmModel() {
  if (modelState === 'ready') return Promise.resolve();
  if (warming) return warming;
  modelState = 'loading';
  crumb('loading the speech model');
  setQueueStatus('Getting the speech model ready…');
  warming = loadModel().then(() => {
    modelState = 'ready';
  }, (err) => {
    modelState = 'failed';
    setQueueStatus(/network|load failed|fetch/i.test(err.message)
      ? 'The speech model didn’t download (network error). Bookmarks are still saved; quotes will be found once it loads.'
      : 'Speech model could not load: ' + err.message);
    throw err;
  }).finally(() => {
    warming = null; crumb(null);
    if (modelState === 'ready') setQueueStatus('');
    renderModelNote();
  });
  renderModelNote();
  return warming;
}

export function setQueueStatus(msg) {
  $('queueStatus').textContent = msg;
  $('modelNote').textContent = msg || (modelState === 'ready' ? 'Speech model ready.' : '');
  $('modelAgain').hidden = modelState !== 'failed';
}
function renderModelNote() { setQueueStatus($('queueStatus').textContent); }
