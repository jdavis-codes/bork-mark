// Copies picked files into the browser's private file system (OPFS) so they
// survive restarts. Runs in a worker because Safari only allows fast file
// writes from here.

self.onmessage = async (e) => {
  const { id, op, dir, name, blob } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    if (op === 'write') {
      const d = await root.getDirectoryHandle(dir, { create: true });
      const fh = await d.getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      try {
        h.truncate(0);
        const CHUNK = 4 << 20;
        let off = 0;
        while (off < blob.size) {
          const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
          h.write(buf, { at: off });
          off += buf.length;
          self.postMessage({ id, progress: off / blob.size });
        }
        h.flush();
      } finally {
        h.close();
      }
    } else if (op === 'remove') {
      await root.removeEntry(dir, { recursive: true }).catch(() => {});
    }
    self.postMessage({ id, done: true });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
