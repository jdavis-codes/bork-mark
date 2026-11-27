// Speech to text: the Whisper worker, loading its model (with retries), letting go of it
// while the app is in the background, and the status line that reports on it.

import { busy } from './ui/busy.js';
import { crumb, detail, log } from './log.js';
import { runQueue } from './queue.js';
import { settings, state } from './state.js';
import { $ } from './ui/dom.js';

const MODEL = 'onnx-community/whisper-tiny.en_timestamped';

// ---------- speech-to-text worker ----------
let altRuntime = false;   // fetch the model's runtime from the second host
export let asrWorker = null, asrSeq = 0, modelState = 'idle';   // idle | loading | ready | failed
const asrJobs = new Map();
function asrRequest(pcm) {
  return ask({ audio: pcm || null, model: MODEL, device: 'wasm', alt: altRuntime }, pcm ? [pcm.buffer] : []);
}
// Sends one request to the worker; the reply resolves it.
function ask(message, transfer = []) {
  if (!asrWorker) {
    asrWorker = new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' });
    asrWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress' && m.total) {
        if (modelNotice) modelNotice.say('Model ' + Math.round(100 * m.loaded / m.total) + '%');   // the one-time download
        return;
      }
      if (m.type === 'file') { detail('model file downloaded: ' + m.file); return; }
      const job = asrJobs.get(m.id);
      if (!job) return;
      asrJobs.delete(m.id);
      if (document.visibilityState === 'hidden') letGoLater(LET_GO_AFTER);
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
    asrWorker.postMessage({ id, ...message }, transfer);
  });
}
// Embeddings for some texts: one Float32Array of `size` numbers per text,
// each a direction standing for the text's meaning (unit length, so the dot
// product of two is how alike they are, from -1 to 1).
//
// The sentence model shares Whisper's worker. A worker of its own, ended after
// each search, was tried: two copies of the model runtime pushed the peak
// higher (about 820 MB against 740 in Chromium) and ending it gave little
// back. Sharing also means the two never run at the same time.
export async function embed(texts) {
  const r = await ask({ type: 'embed', texts });
  detail('meaning of ' + texts.length + (texts.length === 1 ? ' text' : ' texts') + ' in ' + Math.round(r.runMs) + ' ms' + (r.loadMs > 50 ? ', model loaded in ' + Math.round(r.loadMs) + ' ms' : ''));
  return texts.map((_, i) => r.vectors.subarray(i * r.size, (i + 1) * r.size));
}
// Every crash on an iPhone so far came while transcribing within five seconds
// of the model loading (three of three, one of them a 30 s clip), and none of
// the transcriptions that began 25 s or more after it, however long the clip.
// Loading leaves a lot behind for the browser to clear away (the model's files
// are read whole, then copied into the runtime), and transcribing on top of
// that is one heavy step overlapping another. So the first transcription
// after a load waits until the model has been ready for SETTLE.
const SETTLE = 10000;
let readyAt = 0, settling = 0;
export async function transcribe(pcm) {
  settling++;
  try {
    if (modelState !== 'ready') await warmModel();   // let go in the background, or never loaded
    const wait = readyAt + SETTLE - Date.now();
    if (wait > 0) {
      detail('waiting ' + (wait / 1000).toFixed(1) + ' s after the model loaded before transcribing');
      await new Promise((r) => setTimeout(r, wait));
    }
  } finally { settling--; }
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
      log('speech model ready in ' + (r.loadMs / 1000).toFixed(1) + ' s' + (r.saved ? ', from the copy on this device' : ', downloaded') + (attempt ? ', on try ' + (attempt + 1) : '') + (altRuntime ? ', from the second host' : ''));
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
// While it loads, the notice at the top says so; nothing is said when it is
// ready. Only a failure gets words: a box in the library with a Try again
// button, and the same line in the Bookmarks sheet.
let warming = null, modelNotice = null, failText = '';
export function warmModel() {
  if (modelState === 'ready') return Promise.resolve();
  if (warming) return warming;
  modelState = 'loading'; letGone = false;
  failText = '';
  crumb('loading the speech model');
  setQueueStatus('');
  modelNotice = busy('Loading model');
  warming = loadModel().then(() => {
    modelState = 'ready'; readyAt = Date.now();
  }, (err) => {
    modelState = 'failed';
    failText = 'Speech model didn’t load';   // the log has the reason
    throw err;
  }).finally(() => {
    warming = null; crumb(null);
    modelNotice(); modelNotice = null;
    setQueueStatus(failText);
  });
  return warming;
}

// ---------- letting go of the model in the background ----------
// The model is most of the app's memory, and iOS ends the background apps that
// hold the most first: with it loaded, the app was gone within seconds of
// leaving the screen, and every return was a fresh start. So when the app is
// hidden and the worker has nothing to do, the worker is ended, which gives
// the memory back. The model is read again from the copy on the device (a few
// seconds) shortly after the app is back on screen, so that it has settled by
// the time a bookmark is made (see SETTLE).
//
// With "Find quotes while locked" on, work can carry on while hidden, so the
// worker is given a moment after each job in case another follows.
const LET_GO_AFTER = 4000, BACK_AFTER = 1500;   // BACK_AFTER: a glance at the app doesn't load it
let letGoTimer = null, letGone = false;
function letGo() {
  if (document.visibilityState !== 'hidden' || !asrWorker || asrJobs.size || warming || settling) return;
  asrWorker.terminate(); asrWorker = null; letGone = modelState === 'ready'; modelState = 'idle';
  detail('speech model let go while in the background');
}
function letGoLater(ms) {
  clearTimeout(letGoTimer);
  letGoTimer = setTimeout(letGo, ms);
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(letGoTimer);
  if (document.visibilityState !== 'hidden') {
    if (letGone) letGoTimer = setTimeout(() => { if (letGone && modelState === 'idle') warmModel().catch(() => {}); }, BACK_AFTER);
    return;
  }
  if (settings.bgQuotes) letGoLater(LET_GO_AFTER); else letGo();
});

export function setQueueStatus(msg) {
  $('queueStatus').textContent = msg;
  $('modelFail').hidden = modelState !== 'failed';
  $('modelNote').textContent = failText;
}
