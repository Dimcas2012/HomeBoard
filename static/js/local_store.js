/**
 * Cyclic local recordings in IndexedDB (device storage).
 * Oldest segments are deleted when total size exceeds the limit.
 */
(() => {
  const DB_NAME = 'homeboard_local_rec';
  const DB_VERSION = 1;
  const STORE = 'segments';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('by_started', 'startedAt', { unique: false });
          os.createIndex('by_camera', 'cameraId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  }

  async function addSegment(record) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(record);
    await txDone(tx);
    db.close();
  }

  async function listSegments(cameraId = null) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.index('by_started').getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    const sorted = rows.sort((a, b) => a.startedAt - b.startedAt);
    return cameraId ? sorted.filter((r) => r.cameraId === cameraId) : sorted;
  }

  async function deleteSegment(id) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
    db.close();
  }

  async function clearAll(cameraId = null) {
    const all = await listSegments(cameraId);
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of all) store.delete(row.id);
    await txDone(tx);
    db.close();
  }

  async function totalBytes(cameraId = null) {
    const rows = await listSegments(cameraId);
    return rows.reduce((s, r) => s + (r.size || 0), 0);
  }

  async function enforceQuota(maxBytes, cameraId = null) {
    if (!maxBytes || maxBytes <= 0) return { deleted: 0, used: await totalBytes(cameraId) };
    let rows = await listSegments(cameraId);
    let used = rows.reduce((s, r) => s + (r.size || 0), 0);
    let deleted = 0;
    while (used > maxBytes && rows.length) {
      const oldest = rows.shift();
      await deleteSegment(oldest.id);
      used -= oldest.size || 0;
      deleted += 1;
    }
    return { deleted, used };
  }

  function pickMime() {
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm',
      'video/mp4',
    ];
    for (const mime of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  }

  /**
   * Continuous segmented recorder with cyclic overwrite.
   */
  class LoopRecorder {
    constructor({
      getStream,
      getCameraId,
      getMaxBytes,
      segmentMs = 20000,
      onStatus = () => {},
      onUsage = () => {},
    }) {
      this.getStream = getStream;
      this.getCameraId = getCameraId;
      this.getMaxBytes = getMaxBytes;
      this.segmentMs = segmentMs;
      this.onStatus = onStatus;
      this.onUsage = onUsage;
      this.active = false;
      this.recorder = null;
      this.chunks = [];
      this.segmentStartedAt = 0;
      this._stopping = false;
      this._segmentTimer = null;
      this.mime = pickMime();
    }

    async refreshUsage() {
      const used = await totalBytes(this.getCameraId());
      const max = this.getMaxBytes();
      this.onUsage({ used, max });
      return { used, max };
    }

    async start() {
      if (this.active) return;
      if (!this.mime) throw new Error('MediaRecorder не підтримується в цьому браузері');
      const stream = this.getStream();
      if (!stream) throw new Error('Немає медіа-стріму для запису');
      this.active = true;
      this._stopping = false;
      this.onStatus('Локальний цикл: запис…');
      await this._startSegment();
      await this.refreshUsage();
    }

    async stop() {
      this._stopping = true;
      this.active = false;
      if (this._segmentTimer) {
        clearTimeout(this._segmentTimer);
        this._segmentTimer = null;
      }
      if (this.recorder && this.recorder.state === 'recording') {
        await new Promise((resolve) => {
          const rec = this.recorder;
          const prev = rec.onstop;
          rec.onstop = async (ev) => {
            try { await prev?.call(rec, ev); } finally { resolve(); }
          };
          rec.stop();
        });
      } else {
        await this.refreshUsage();
      }
      this.recorder = null;
      this.onStatus('Локальний цикл: стоп');
    }

    async _startSegment() {
      if (!this.active || this._stopping) return;
      const stream = this.getStream();
      if (!stream) return;
      this.chunks = [];
      this.segmentStartedAt = Date.now();
      const rec = new MediaRecorder(stream, { mimeType: this.mime });
      this.recorder = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      rec.onerror = (e) => {
        console.error('loop recorder error', e);
        this.onStatus('Локальний цикл: помилка');
      };
      rec.onstop = () => {
        this._persistSegment().catch((err) => console.error(err));
      };
      rec.start(1000);
      this._segmentTimer = setTimeout(() => {
        if (this.recorder === rec && rec.state === 'recording') rec.stop();
      }, this.segmentMs);
    }

    async _persistSegment() {
      if (this._segmentTimer) {
        clearTimeout(this._segmentTimer);
        this._segmentTimer = null;
      }
      const chunks = this.chunks.splice(0);
      const startedAt = this.segmentStartedAt;
      const endedAt = Date.now();
      this.recorder = null;

      if (chunks.length) {
        const blob = new Blob(chunks, { type: this.mime || 'video/webm' });
        if (blob.size >= 1000) {
          await addSegment({
            cameraId: this.getCameraId() || '',
            startedAt,
            endedAt,
            size: blob.size,
            mime: blob.type || this.mime,
            blob,
          });
          await enforceQuota(this.getMaxBytes(), this.getCameraId() || null);
          await this.refreshUsage();
        }
      }

      if (this.active && !this._stopping) {
        await this._startSegment();
      }
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
    return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
  }

  window.HomeBoardLocalStore = {
    listSegments,
    deleteSegment,
    clearAll,
    totalBytes,
    enforceQuota,
    LoopRecorder,
    formatBytes,
    pickMime,
  };
})();
