// Files kept on the device, in the browser's private file system (OPFS), written through a worker.

import { NS } from './state.js';

let storeWorker = null, storeSeq = 0;
const storeJobs = new Map();
export function store(op, dir, name, blob, onProgress) {
  if (!storeWorker) {
    storeWorker = new Worker(new URL('./store-worker.js', import.meta.url));
    storeWorker.onmessage = (e) => {
      const job = storeJobs.get(e.data.id);
      if (!job) return;
      if (e.data.progress != null) { if (job.onProgress) job.onProgress(e.data.progress); return; }
      storeJobs.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++storeSeq;
    storeJobs.set(id, { resolve, reject, onProgress });
    storeWorker.postMessage({ id, op, dir: NS + dir, name, blob });
  });
}
export async function stored(dir, name) {
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(NS + dir);
    return await (await d.getFileHandle(name)).getFile();
  } catch (e) { return null; }
}
