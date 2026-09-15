/**
 * Optional on-device object prefilter.
 * Prefers Android native detectJpeg when available, else TF.js COCO-SSD.
 * Loaded lazily only when phone_assist is enabled.
 */
(() => {
  const state = {
    ready: false,
    loading: null,
    model: null,
    classes: null,
    backend: null,
  };

  function nativeCaps() {
    try {
      const n = window.HomeBoardNative;
      if (!n?.getCapabilities) return {};
      return JSON.parse(n.getCapabilities() || '{}');
    } catch {
      return {};
    }
  }

  function nativeDetectAvailable() {
    const n = window.HomeBoardNative;
    return !!(nativeCaps().phone_detect && n && typeof n.detectJpeg === 'function');
  }

  function canvasToJpegBase64(canvas, quality) {
    try {
      const url = canvas.toDataURL('image/jpeg', quality || 0.7);
      const i = url.indexOf('base64,');
      return i >= 0 ? url.slice(i + 7) : '';
    } catch {
      return '';
    }
  }

  function detectNative(canvas, classes) {
    const n = window.HomeBoardNative;
    const b64 = canvasToJpegBase64(canvas, 0.7);
    if (!b64) return [];
    const raw = n.detectJpeg(b64, JSON.stringify(classes || state.classes || []));
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensure(classes) {
    state.classes = classes || state.classes;
    if (nativeDetectAvailable()) {
      state.ready = true;
      state.backend = 'native';
      return true;
    }
    if (state.ready && state.backend === 'tfjs') return true;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
        // eslint-disable-next-line no-undef
        state.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        state.ready = true;
        state.backend = 'tfjs';
        return true;
      } catch (err) {
        console.warn('HomeBoardPhoneAI load failed', err);
        state.ready = false;
        state.backend = null;
        return false;
      } finally {
        state.loading = null;
      }
    })();
    return state.loading;
  }

  async function detect(canvas, classes) {
    if (nativeDetectAvailable()) {
      try {
        return detectNative(canvas, classes);
      } catch (err) {
        console.warn('HomeBoard native detect failed', err);
      }
    }
    const ok = await ensure(classes);
    if (!ok || !state.model || !canvas) return [];
    const want = new Set((classes || state.classes || []).map((c) => String(c).toLowerCase()));
    const preds = await state.model.detect(canvas, 12, 0.4);
    return (preds || [])
      .filter((p) => !want.size || want.has(String(p.class).toLowerCase()))
      .map((p) => ({
        cls: String(p.class).toLowerCase(),
        conf: Number(p.score) || 0,
        xyxy: [
          p.bbox[0],
          p.bbox[1],
          p.bbox[0] + p.bbox[2],
          p.bbox[1] + p.bbox[3],
        ],
      }));
  }

  window.HomeBoardPhoneAI = { ensure, detect, backend: () => state.backend };
})();
