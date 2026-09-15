(() => {
  const ICE = window.HomeBoardWebRTC?.iceConfig?.() || {
    iceServers: window.HOMEBOARD?.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };
  const STORAGE_KEY = 'homeboard_camera';
  const FACING_KEY = 'homeboard_facing';
  const DUAL_KEY = 'homeboard_dual';
  const LOCAL_LOOP_KEY = 'homeboard_local_loop';
  const LOCAL_MAX_KEY = 'homeboard_local_max_mb';
  const MOTION_KEY = 'homeboard_motion';
  const MOTION_COLS = 4;
  const MOTION_ROWS = 3;
  const MOTION_W = 64;
  const MOTION_H = 36;

  const statusEl = document.getElementById('status');
  const pairForm = document.getElementById('pair-form');
  const liveControls = document.getElementById('live-controls');
  const previewWrap = document.getElementById('previewWrap');
  const localVideo = document.getElementById('localVideo');
  const pipVideo = document.getElementById('pipVideo');
  const composeCanvas = document.getElementById('composeCanvas');
  const camName = document.getElementById('camName');
  const facingSelect = document.getElementById('facingSelect');
  const facingLabel = document.getElementById('facingLabel');
  const dualCam = document.getElementById('dualCam');
  const dualHint = document.getElementById('dualHint');
  const btnFlip = document.getElementById('btnFlip');
  const localLoopEl = document.getElementById('localLoop');
  const localMaxMbEl = document.getElementById('localMaxMb');
  const localUsageEl = document.getElementById('localUsage');
  const localHint = document.getElementById('localHint');
  const localPanel = document.getElementById('localPanel');
  const localList = document.getElementById('localList');
  const localPlayer = document.getElementById('localPlayer');
  const btnLocalList = document.getElementById('btnLocalList');
  const btnLocalClear = document.getElementById('btnLocalClear');
  const motionPanel = document.getElementById('motionPanel');
  const motionSectorGrid = document.getElementById('motionSectorGrid');
  const motionOverlay = document.getElementById('motionOverlay');
  const motionSensEl = document.getElementById('motionSensitivity');
  const motionSoundEnabledEl = document.getElementById('motionSoundEnabled');
  const motionSoundSensEl = document.getElementById('motionSoundSensitivity');
  const motionSoundLiveEl = document.getElementById('motionSoundLive');
  const motionCdEl = document.getElementById('motionCooldown');
  const motionIntervalEl = document.getElementById('motionInterval');
  const motionShowOverlayEl = document.getElementById('motionShowOverlay');
  const motionLiveScoreEl = document.getElementById('motionLiveScore');
  const btnMotionSettings = document.getElementById('btnMotionSettings');
  const btnMotionClose = document.getElementById('btnMotionClose');

  let creds = null;
  let localStream = null; // outbound stream (single cam or canvas+audio)
  let rawMain = null;
  let rawPip = null;
  let ws = null;
  let peers = new Map();
  let motionTimer = null;
  let soundTimer = null;
  let soundAudioCtx = null;
  let soundAnalyser = null;
  let soundSource = null;
  let soundData = null;
  let soundTrackId = null;
  let lastSoundRms = 0;
  let composeTimer = null;
  let lastFrame = null;
  let recordedChunks = [];
  let lastMotionEventId = null;
  let motionCooldownUntil = 0;
  let lastHotSectors = [];
  let motionSettings = null;
  let telegramPrefs = {
    telegram_enabled: false,
    send_screenshot: true,
    jpeg_quality: 0.7,
    max_width: 1280,
  };
  let analyticsPrefs = {
    enabled: false,
    phone_assist: false,
    trigger_mode: 'motion',
    fps: 1,
    classes: ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'dog', 'cat'],
  };
  let analyticsTimer = null;
  let lastAnalyticsUploadAt = 0;
  let lastDetectionEventId = null;
  let lastPhoneHints = [];
  let facingMode = localStorage.getItem(FACING_KEY) || 'environment';
  let dualMode = localStorage.getItem(DUAL_KEY) === '1';
  let wantLocalLoop = localStorage.getItem(LOCAL_LOOP_KEY) === '1';
  let loopRecorder = null;
  let motionRecording = false;
  let motionRecorder = null;

  if (facingSelect) facingSelect.value = facingMode === 'user' ? 'user' : 'environment';
  if (dualCam) dualCam.checked = dualMode;
  if (localLoopEl) localLoopEl.checked = wantLocalLoop;
  if (localMaxMbEl) {
    const savedMax = localStorage.getItem(LOCAL_MAX_KEY);
    if (savedMax) localMaxMbEl.value = savedMax;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function loadCreds() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  function saveCreds(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    creds = data;
  }

  const MOTION_DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

  function defaultSchedule() {
    return {
      enabled: false,
      days: [true, true, true, true, true, true, true], // Mon..Sun
      start_hour: 0,
      end_hour: 24, // 24 = кінець доби; equal to start means 24/7 within selected days
    };
  }

  function normalizeSchedule(raw) {
    const base = defaultSchedule();
    if (!raw || typeof raw !== 'object') return base;
    const days = Array.isArray(raw.days)
      ? raw.days.slice(0, 7).map(Boolean)
      : base.days.slice();
    while (days.length < 7) days.push(true);
    let start = Number(raw.start_hour);
    let end = Number(raw.end_hour);
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = 24;
    start = Math.min(23, Math.max(0, Math.round(start)));
    end = Math.min(24, Math.max(0, Math.round(end)));
    return {
      enabled: !!raw.enabled,
      days,
      start_hour: start,
      end_hour: end,
    };
  }

  function defaultMotionSettings() {
    return {
      sensitivity: 6,
      sound_enabled: false,
      sound_sensitivity: 6,
      cooldown_sec: 8,
      interval_ms: 400,
      sectors: Array(MOTION_COLS * MOTION_ROWS).fill(true),
      show_overlay: false,
      schedule: defaultSchedule(),
    };
  }

  function loadMotionSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(MOTION_KEY) || 'null');
      const base = defaultMotionSettings();
      if (!raw || typeof raw !== 'object') return base;
      const sectors = Array.isArray(raw.sectors)
        ? raw.sectors.slice(0, MOTION_COLS * MOTION_ROWS).map(Boolean)
        : base.sectors.slice();
      while (sectors.length < MOTION_COLS * MOTION_ROWS) sectors.push(true);
      return {
        sensitivity: Math.min(10, Math.max(1, Number(raw.sensitivity) || base.sensitivity)),
        sound_enabled: !!raw.sound_enabled,
        sound_sensitivity: Math.min(10, Math.max(1, Number(raw.sound_sensitivity) || base.sound_sensitivity)),
        cooldown_sec: Math.min(60, Math.max(3, Number(raw.cooldown_sec) || base.cooldown_sec)),
        interval_ms: Math.min(1000, Math.max(200, Number(raw.interval_ms) || base.interval_ms)),
        sectors,
        show_overlay: !!raw.show_overlay,
        schedule: normalizeSchedule(raw.schedule),
      };
    } catch {
      return defaultMotionSettings();
    }
  }

  function saveMotionSettings() {
    localStorage.setItem(MOTION_KEY, JSON.stringify(motionSettings));
  }

  function motionThreshold() {
    // sensitivity 1 → ~43, 6 → ~18, 10 → ~4 (matches old default at ~6)
    return Math.max(4, Math.round(48 - motionSettings.sensitivity * 5));
  }

  function soundThreshold() {
    // sensitivity 1 → ~0.20, 6 → ~0.10, 10 → ~0.02 (RMS 0..1)
    return Math.max(0.02, Number((0.22 - motionSettings.sound_sensitivity * 0.02).toFixed(3)));
  }

  function scheduleDayIndex(date = new Date()) {
    const js = date.getDay(); // 0=Sun
    return js === 0 ? 6 : js - 1; // Mon=0..Sun=6
  }

  function isMotionScheduleActive(date = new Date()) {
    const sch = motionSettings?.schedule;
    if (!sch || !sch.enabled) return true;
    const dayIdx = scheduleDayIndex(date);
    if (!sch.days[dayIdx]) return false;
    const h = date.getHours();
    const start = Number(sch.start_hour) || 0;
    let end = Number(sch.end_hour);
    if (!Number.isFinite(end)) end = 24;
    if (start === end) return true;
    if (start < end) return h >= start && h < end;
    // overnight, e.g. 22 → 6
    return h >= start || h < end;
  }

  function scheduleSummary(sch = motionSettings?.schedule) {
    if (!sch || !sch.enabled) return 'розклад вимкнено (завжди)';
    const days = sch.days
      .map((on, i) => (on ? MOTION_DAY_LABELS[i] : null))
      .filter(Boolean)
      .join(' ');
    const endLabel = sch.end_hour === 24 ? '24:00' : `${String(sch.end_hour).padStart(2, '0')}:00`;
    const startLabel = `${String(sch.start_hour).padStart(2, '0')}:00`;
    return `${days || 'немає днів'} · ${startLabel}–${endLabel}`;
  }

  function fillHourSelect(selectEl, include24 = false) {
    if (!selectEl || selectEl.options.length) return;
    const max = include24 ? 24 : 23;
    for (let h = 0; h <= max; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
      selectEl.appendChild(opt);
    }
  }

  function renderMotionDays() {
    const box = document.getElementById('motionDays');
    if (!box || !motionSettings?.schedule) return;
    box.innerHTML = '';
    motionSettings.schedule.days.forEach((on, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = MOTION_DAY_LABELS[idx];
      btn.classList.toggle('on', !!on);
      btn.addEventListener('click', () => {
        motionSettings.schedule.days[idx] = !motionSettings.schedule.days[idx];
        saveMotionSettings();
        applyMotionSettingsToUi();
        emitState();
      });
      box.appendChild(btn);
    });
  }

  function applyMotionSettingsToUi() {
    if (!motionSettings) return;
    if (motionSensEl) motionSensEl.value = String(motionSettings.sensitivity);
    if (motionSoundEnabledEl) motionSoundEnabledEl.checked = !!motionSettings.sound_enabled;
    if (motionSoundSensEl) motionSoundSensEl.value = String(motionSettings.sound_sensitivity);
    if (motionCdEl) motionCdEl.value = String(motionSettings.cooldown_sec);
    if (motionIntervalEl) motionIntervalEl.value = String(motionSettings.interval_ms);
    if (motionShowOverlayEl) motionShowOverlayEl.checked = !!motionSettings.show_overlay;
    const sensLabel = document.getElementById('motionSensLabel');
    const soundSensLabel = document.getElementById('motionSoundSensLabel');
    const cdLabel = document.getElementById('motionCdLabel');
    const ivLabel = document.getElementById('motionIntervalLabel');
    if (sensLabel) sensLabel.textContent = String(motionSettings.sensitivity);
    if (soundSensLabel) soundSensLabel.textContent = String(motionSettings.sound_sensitivity);
    if (cdLabel) cdLabel.textContent = String(motionSettings.cooldown_sec);
    if (ivLabel) ivLabel.textContent = String(motionSettings.interval_ms);
    if (motionSoundSensEl) motionSoundSensEl.disabled = !motionSettings.sound_enabled;

    const sch = motionSettings.schedule || defaultSchedule();
    const schEnabled = document.getElementById('motionScheduleEnabled');
    const schBlock = document.getElementById('motionScheduleBlock');
    const startEl = document.getElementById('motionStartHour');
    const endEl = document.getElementById('motionEndHour');
    const hint = document.getElementById('motionScheduleHint');
    fillHourSelect(startEl, false);
    fillHourSelect(endEl, true);
    if (schEnabled) schEnabled.checked = !!sch.enabled;
    if (schBlock) schBlock.hidden = !sch.enabled;
    if (startEl) startEl.value = String(sch.start_hour);
    if (endEl) endEl.value = String(sch.end_hour);
    if (hint) {
      const active = isMotionScheduleActive();
      hint.textContent = `${scheduleSummary(sch)} · зараз: ${active ? 'фіксація активна' : 'поза розкладом'}`;
    }
    renderMotionDays();
    renderSectorGrid();
    renderMotionOverlay();
  }

  function renderSectorGrid() {
    if (!motionSectorGrid || !motionSettings) return;
    motionSectorGrid.innerHTML = '';
    motionSettings.sectors.forEach((on, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(idx + 1);
      btn.classList.toggle('on', !!on);
      btn.classList.toggle('hot', lastHotSectors.includes(idx));
      btn.title = on ? 'Сектор увімкнено' : 'Сектор вимкнено';
      btn.addEventListener('click', () => {
        motionSettings.sectors[idx] = !motionSettings.sectors[idx];
        saveMotionSettings();
        applyMotionSettingsToUi();
        emitState();
      });
      motionSectorGrid.appendChild(btn);
    });
  }

  function renderMotionOverlay() {
    if (!motionOverlay || !motionSettings) return;
    const show = !!motionSettings.show_overlay;
    motionOverlay.hidden = !show;
    if (!show) return;
    motionOverlay.innerHTML = '';
    motionSettings.sectors.forEach((on, idx) => {
      const cell = document.createElement('span');
      cell.classList.toggle('off', !on);
      cell.classList.toggle('hot', lastHotSectors.includes(idx));
      motionOverlay.appendChild(cell);
    });
  }

  function setMotionSettings(partial = {}) {
    const nextSchedule = partial.schedule != null
      ? normalizeSchedule({ ...(motionSettings?.schedule || {}), ...partial.schedule })
      : normalizeSchedule(motionSettings?.schedule);
    motionSettings = {
      ...defaultMotionSettings(),
      ...motionSettings,
      ...partial,
      sectors: Array.isArray(partial.sectors)
        ? partial.sectors.slice(0, MOTION_COLS * MOTION_ROWS).map(Boolean)
        : (motionSettings?.sectors || defaultMotionSettings().sectors).slice(),
      schedule: nextSchedule,
    };
    while (motionSettings.sectors.length < MOTION_COLS * MOTION_ROWS) {
      motionSettings.sectors.push(true);
    }
    motionSettings.sensitivity = Math.min(10, Math.max(1, Number(motionSettings.sensitivity) || 6));
    motionSettings.sound_enabled = !!motionSettings.sound_enabled;
    motionSettings.sound_sensitivity = Math.min(10, Math.max(1, Number(motionSettings.sound_sensitivity) || 6));
    motionSettings.cooldown_sec = Math.min(60, Math.max(3, Number(motionSettings.cooldown_sec) || 8));
    motionSettings.interval_ms = Math.min(1000, Math.max(200, Number(motionSettings.interval_ms) || 400));
    saveMotionSettings();
    applyMotionSettingsToUi();
    if (motionTimer) startMotion();
  }

  motionSettings = loadMotionSettings();

  function updateFacingUi() {
    if (facingLabel) facingLabel.textContent = dualMode ? 'Головна' : 'Камера';
    if (dualHint) dualHint.hidden = !dualMode;
    if (localHint) localHint.hidden = !wantLocalLoop;
    previewWrap.classList.toggle('dual-mode', dualMode && !!rawMain && !!rawPip);
    if (!dualMode) {
      composeCanvas.hidden = true;
      pipVideo.hidden = true;
      localVideo.hidden = false;
    }
  }

  function getLocalMaxBytes() {
    const mb = Number(localMaxMbEl?.value || localStorage.getItem(LOCAL_MAX_KEY) || 500);
    return Math.max(50, mb) * 1024 * 1024;
  }

  function updateLocalUsage({ used, max }) {
    if (!localUsageEl || !window.HomeBoardLocalStore) return;
    const { formatBytes } = window.HomeBoardLocalStore;
    localUsageEl.textContent = `Локально: ${formatBytes(used || 0)} / ${formatBytes(max || getLocalMaxBytes())}`;
  }

  function ensureLoopRecorder() {
    if (!window.HomeBoardLocalStore) return null;
    if (loopRecorder) return loopRecorder;
    const { LoopRecorder } = window.HomeBoardLocalStore;
    loopRecorder = new LoopRecorder({
      getStream: () => localStream,
      getCameraId: () => creds?.camera_id || '',
      getMaxBytes: getLocalMaxBytes,
      segmentMs: 20000,
      onStatus: (text) => {
        if (wantLocalLoop) setStatus(text);
      },
      onUsage: updateLocalUsage,
    });
    return loopRecorder;
  }

  async function syncLocalLoop() {
    const rec = ensureLoopRecorder();
    if (!rec) return;
    if (wantLocalLoop && localStream && document.getElementById('btnStop') && document.getElementById('btnStop').disabled === false) {
      if (!rec.active) {
        try { await rec.start(); } catch (err) {
          console.error(err);
          alert(err.message || String(err));
          wantLocalLoop = false;
          if (localLoopEl) localLoopEl.checked = false;
          localStorage.setItem(LOCAL_LOOP_KEY, '0');
          updateFacingUi();
        }
      }
    } else if (rec.active) {
      await rec.stop();
    }
    await rec.refreshUsage();
  }

  async function renderLocalList() {
    if (!window.HomeBoardLocalStore || !localList) return;
    const { listSegments, formatBytes } = window.HomeBoardLocalStore;
    const rows = (await listSegments(creds?.camera_id || null)).slice().reverse();
    if (!rows.length) {
      localList.innerHTML = '<div class="empty">Локальних сегментів немає</div>';
      return;
    }
    localList.innerHTML = rows.map((r) => {
      const when = new Date(r.startedAt).toLocaleString('uk-UA');
      const dur = Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000));
      return `<div class="item" data-id="${r.id}">
        <div>
          <strong>${when}</strong>
          <div class="muted">${dur} с · ${formatBytes(r.size || 0)}</div>
        </div>
        <div class="local-seg-actions">
          <button class="btn secondary btn-play" type="button">▶</button>
          <button class="btn secondary btn-dl" type="button">↓</button>
          <button class="btn secondary btn-del" type="button">✕</button>
        </div>
      </div>`;
    }).join('');

    localList.querySelectorAll('.item').forEach((el) => {
      const id = Number(el.dataset.id);
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      el.querySelector('.btn-play').onclick = () => {
        const url = URL.createObjectURL(row.blob);
        localPlayer.src = url;
        localPlayer.play().catch(() => {});
      };
      el.querySelector('.btn-dl').onclick = () => {
        const url = URL.createObjectURL(row.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `homeboard-${id}-${row.startedAt}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      };
      el.querySelector('.btn-del').onclick = async () => {
        await window.HomeBoardLocalStore.deleteSegment(id);
        await renderLocalList();
        await ensureLoopRecorder()?.refreshUsage();
      };
    });
  }

  function applyMirror() {
    if (dualMode) {
      localVideo.classList.remove('mirror');
      return;
    }
    localVideo.classList.toggle('mirror', facingMode === 'user');
  }

  function setFacing(mode) {
    facingMode = mode === 'user' ? 'user' : 'environment';
    localStorage.setItem(FACING_KEY, facingMode);
    if (facingSelect) facingSelect.value = facingMode;
    applyMirror();
  }

  function setDual(on) {
    dualMode = !!on;
    localStorage.setItem(DUAL_KEY, dualMode ? '1' : '0');
    if (dualCam) dualCam.checked = dualMode;
    updateFacingUi();
  }

  function isAndroidApp() {
    return /HomeBoardAndroid/i.test(navigator.userAgent || '') ||
      new URLSearchParams(location.search).get('autostart') === '1';
  }

  function polyfillMediaDevices() {
    if (!navigator.mediaDevices) {
      navigator.mediaDevices = {};
    }
    if (!navigator.mediaDevices.getUserMedia) {
      const legacy = navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia;
      if (!legacy) return false;
      navigator.mediaDevices.getUserMedia = (constraints) => new Promise((resolve, reject) => {
        legacy.call(navigator, constraints, resolve, reject);
      });
    }
    return typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  function assertSecure() {
    polyfillMediaDevices();
    if (!window.isSecureContext) {
      throw new Error(
        'Потрібен HTTPS. Відкрийте https://' + location.host + '/camera/ і підтвердіть сертифікат.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Камера недоступна в цьому WebView. Оновіть Android System WebView / Chrome, або натисніть «Старт стріму» ще раз.'
      );
    }
  }

  let videoInputsCache = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function inferFacingFromLabel(label) {
    const s = String(label || '').toLowerCase();
    if (/front|user|face|selfie|перед|фронт|facing\s*front/.test(s)) return 'user';
    if (/back|rear|environment|world|задн|основ|facing\s*back|facing\s*rear|facing\s*environment/.test(s)) {
      return 'environment';
    }
    return null;
  }

  async function getVideoInputs({ refresh = false } = {}) {
    if (!refresh && videoInputsCache?.length) return videoInputsCache;
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let devices = await navigator.mediaDevices.enumerateDevices();
    let videos = devices.filter((d) => d.kind === 'videoinput');
    // Labels often empty until a camera was granted once
    if (videos.length && !videos.some((d) => d.label)) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        stopStream(tmp);
        await sleep(isAndroidApp() ? 300 : 80);
        devices = await navigator.mediaDevices.enumerateDevices();
        videos = devices.filter((d) => d.kind === 'videoinput');
      } catch (_) { /* ignore */ }
    }
    videoInputsCache = videos;
    return videos;
  }

  function trackFacing(track) {
    try {
      const settings = track?.getSettings?.() || {};
      if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
        return settings.facingMode;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async function openCamera(facing, { withAudio = false, excludeDeviceIds = [] } = {}) {
    assertSecure();
    const mode = facing === 'user' ? 'user' : 'environment';
    const exclude = new Set((excludeDeviceIds || []).filter(Boolean));
    const inputs = (await getVideoInputs()).filter((d) => !exclude.has(d.deviceId));

    const preferred = [];
    const unknown = [];
    for (const d of inputs) {
      const f = inferFacingFromLabel(d.label);
      if (f === mode) preferred.push(d);
      else if (!f) unknown.push(d);
    }

    const videoTries = [];
    // 1) Known matching deviceIds
    for (const d of preferred) {
      videoTries.push({ deviceId: { exact: d.deviceId } });
      videoTries.push({ deviceId: { ideal: d.deviceId } });
    }
    // 2) facingMode — critical on Android WebView (do NOT put bare `true` first)
    videoTries.push(
      { facingMode: { exact: mode } },
      { facingMode: { ideal: mode } },
      { facingMode: mode },
    );
    // 3) Unlabeled devices last (labels often empty until after grant)
    for (const d of unknown) {
      videoTries.push({ deviceId: { exact: d.deviceId } });
      videoTries.push({ deviceId: { ideal: d.deviceId } });
    }
    // Last resort only when we have no device list at all
    if (!inputs.length) videoTries.push(true);

    let lastErr;
    for (const video of videoTries) {
      for (const audio of withAudio ? [true, false] : [false]) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
          const track = stream.getVideoTracks()[0];
          const got = trackFacing(track);
          if (got && got !== mode) {
            stopStream(stream);
            continue;
          }
          const deviceId = track?.getSettings?.()?.deviceId;
          if (deviceId && exclude.has(deviceId)) {
            stopStream(stream);
            continue;
          }
          // Refresh labels after a successful open
          getVideoInputs({ refresh: true }).catch(() => {});
          return stream;
      } catch (err) {
        lastErr = err;
      }
    }
    }
      throw lastErr || new Error('Не вдалося відкрити камеру');
    }

  function stopStream(stream) {
    stream?.getTracks().forEach((t) => t.stop());
  }

  async function releaseRawCameras() {
    stopCompose();
    stopStream(rawPip);
    stopStream(rawMain);
    rawPip = null;
    rawMain = null;
    if (localVideo) localVideo.srcObject = null;
    if (pipVideo) pipVideo.srcObject = null;
    // Android WebView needs a beat to free the HAL camera before reopen
    await sleep(isAndroidApp() ? 400 : 60);
  }

  function stopCompose() {
    if (composeTimer) {
      cancelAnimationFrame(composeTimer);
      composeTimer = null;
    }
  }

  function drawCover(ctx, video, x, y, w, h, mirror = false) {
    if (!video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, -(w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(video, dx, dy, dw, dh);
    }
    ctx.restore();
  }

  function startComposeLoop() {
    stopCompose();
    const ctx = composeCanvas.getContext('2d');
    const W = 1280;
    const H = 720;
    composeCanvas.width = W;
    composeCanvas.height = H;
    composeCanvas.hidden = false;
    localVideo.hidden = true;
    pipVideo.hidden = true;
    previewWrap.classList.add('dual-mode');

    const tick = () => {
      // localVideo = environment, pipVideo = user
      const envEl = localVideo;
      const userEl = pipVideo;
      const main = facingMode === 'environment' ? envEl : userEl;
      const pip = facingMode === 'environment' ? userEl : envEl;

      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, W, H);
      drawCover(ctx, main, 0, 0, W, H, main === userEl);

      const pw = Math.round(W * 0.28);
      const ph = Math.round(H * 0.28);
      const mx = 16;
      const my = 16;
      const px = W - pw - mx;
      const py = H - ph - my;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
      drawCover(ctx, pip, px, py, pw, ph, pip === userEl);
      ctx.strokeStyle = 'rgba(61,214,198,.85)';
      ctx.lineWidth = 3;
      ctx.strokeRect(px - 1, py - 1, pw + 2, ph + 2);

      composeTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  async function ensureMicOnStream(stream) {
    if (!stream) return stream;
    if (stream.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled)) {
      return stream;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      mic.getAudioTracks().forEach((t) => {
        t.enabled = true;
        stream.addTrack(t);
      });
    } catch (err) {
      console.warn('mic attach failed', err);
    }
    return stream;
  }

  function senderByKind(pc, kind) {
    const live = pc.getSenders().find((s) => s.track?.kind === kind);
    if (live) return live;
    if (kind !== 'audio') return null;
    // Empty sendonly transceiver reserved for mic (no track yet).
    const reserved = pc.getTransceivers().find((t) => (
      t.sender
      && !t.sender.track
      && (t.direction === 'sendonly' || t.direction === 'sendrecv')
    ));
    return reserved?.sender || null;
  }

  async function publishOutbound(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Немає відео-доріжки');

    localStream = stream;
    for (const pc of peers.values()) {
      const videoSender = senderByKind(pc, 'video');
      if (videoSender) {
        try { await videoSender.replaceTrack(videoTrack); } catch (err) { console.warn(err); }
      }
      const audioTrack = stream.getAudioTracks().find((t) => t.readyState === 'live') || null;
      const audioSender = senderByKind(pc, 'audio');
      if (audioTrack && audioSender) {
        try { await audioSender.replaceTrack(audioTrack); } catch (err) { console.warn(err); }
      } else if (audioTrack && !audioSender) {
        try { pc.addTrack(audioTrack, stream); } catch (err) { console.warn(err); }
      }
    }
    if (motionRecording && motionRecorder) {
      try { motionRecorder.stop(); } catch (_) {}
    }
    if (wantLocalLoop && loopRecorder?.active) {
      try {
        await loopRecorder.stop();
        await loopRecorder.start();
      } catch (err) {
        console.warn(err);
      }
    }
  }

  async function startDualMedia() {
    setStatus('Відкриття обох камер…');
    await releaseRawCameras();

    let envStream;
    let userStream;
    const openPair = async (firstFacing) => {
      const secondFacing = firstFacing === 'environment' ? 'user' : 'environment';
      const first = await openCamera(firstFacing, { withAudio: firstFacing === 'user' });
      const firstId = first.getVideoTracks()[0]?.getSettings?.()?.deviceId;
      let second;
      try {
        second = await openCamera(secondFacing, {
          withAudio: secondFacing === 'user' && !first.getAudioTracks().length,
          excludeDeviceIds: firstId ? [firstId] : [],
        });
      } catch (err) {
        stopStream(first);
        throw err;
      }
      return firstFacing === 'environment'
        ? { envStream: first, userStream: second }
        : { envStream: second, userStream: first };
    };

    try {
      ({ envStream, userStream } = await openPair('environment'));
    } catch (err1) {
      try {
        ({ envStream, userStream } = await openPair('user'));
      } catch (err2) {
        stopStream(envStream);
        stopStream(userStream);
        throw new Error(
          'Цей пристрій не дозволяє дві камери одночасно. ' +
          (err2.message || err1.message || String(err2))
        );
      }
    }

    // Stop previous outbound canvas tracks only (raw cams are fresh)
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
      localStream = null;
    }

    rawMain = envStream;
    rawPip = userStream;
    localVideo.srcObject = envStream;
    pipVideo.srcObject = userStream;
    localVideo.muted = true;
    pipVideo.muted = true;
    try { await localVideo.play(); } catch (_) {}
    try { await pipVideo.play(); } catch (_) {}

    await sleep(250);
    startComposeLoop();

    const canvasStream = composeCanvas.captureStream(24);
    let audioTrack =
      userStream.getAudioTracks()[0] ||
      envStream.getAudioTracks()[0] ||
      null;
    if (!audioTrack) {
      const micOnly = new MediaStream();
      await ensureMicOnStream(micOnly);
      audioTrack = micOnly.getAudioTracks()[0] || null;
    }
    const outbound = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioTrack ? [audioTrack] : []),
    ]);

    await publishOutbound(outbound);
    applyMirror();
    updateFacingUi();
    return outbound;
  }

  async function startSingleMedia() {
    previewWrap.classList.remove('dual-mode');
    composeCanvas.hidden = true;
    pipVideo.hidden = true;
    localVideo.hidden = false;

    await releaseRawCameras();

    const stream = await openCamera(facingMode, { withAudio: true });
    await ensureMicOnStream(stream);
    // Drop old outbound (canvas or previous cam) after new stream is ready
    if (localStream && localStream !== stream) {
      localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
    }
    rawMain = stream;

    localVideo.srcObject = stream;
    localVideo.muted = true;
    applyMirror();
    try { await localVideo.play(); } catch (_) {}

    await publishOutbound(stream);
    updateFacingUi();
    return stream;
  }

  async function ensureMedia({ force = false } = {}) {
    if (localStream && !force) return localStream;
    if (dualMode) return startDualMedia();
    return startSingleMedia();
  }

  async function switchCamera(nextFacing) {
    const target = nextFacing || (facingMode === 'user' ? 'environment' : 'user');
    if (nextFacing && target === facingMode && localStream && !dualMode && rawMain) {
      updateFacingUi();
      return;
    }
    const prevFacing = facingMode;
    setFacing(target);
    if (!localStream && !rawMain) return;

    try {
      if (dualMode) {
        setStatus(target === 'user' ? 'Головна: фронтальна' : 'Головна: задня');
        updateFacingUi();
        setTimeout(() => {
          setStatus(peers.size ? 'Streaming' : (ws?.readyState === WebSocket.OPEN ? 'Online · очікування viewer' : 'Готово до стріму'));
        }, 600);
        return;
      }
      setStatus(target === 'user' ? 'Фронтальна…' : 'Задня…');
      await startSingleMedia();
      setStatus(peers.size ? 'Streaming' : (ws?.readyState === WebSocket.OPEN ? 'Online · очікування viewer' : 'Готово до стріму'));
    } catch (err) {
      console.error(err);
      setFacing(prevFacing);
      setStatus('Не вдалося змінити камеру');
      alert(err.message || String(err));
      throw err;
    }
  }

  async function toggleDualMode(on) {
    const was = dualMode;
    setDual(on);
    if (!localStream && !rawMain) return;
    try {
      if (on) {
        await startDualMedia();
      } else {
        await startSingleMedia();
      }
      setStatus(peers.size ? 'Streaming' : (ws?.readyState === WebSocket.OPEN ? 'Online · очікування viewer' : 'Готово до стріму'));
    } catch (err) {
      console.error(err);
      setDual(was);
      setStatus('Dual camera недоступна');
      alert(err.message || String(err));
      throw err;
    }
  }

  function wsConnect() {
    if (!creds?.camera_id || !creds?.device_token) {
      creds = loadCreds() || creds;
    }
    if (!creds?.camera_id || !creds?.device_token) {
      setStatus('Немає credentials — зробіть pairing');
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/signal/?role=camera&camera_id=${encodeURIComponent(creds.camera_id)}&token=${encodeURIComponent(creds.device_token)}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      setStatus('Online · очікування viewer');
      emitState();
    };
    ws.onclose = () => setStatus('Відключено');
    ws.onmessage = onSignal;
  }

  async function onSignal(evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (_) {
      return;
    }
    if (msg.type === 'watch' && msg.from === 'viewer') {
      await createOfferForViewer(msg.viewer_channel);
      return;
    }
    if (msg.type === 'answer' && msg.from === 'viewer') {
      const pc = peers.get(msg.viewer_channel);
      if (pc) await pc.setRemoteDescription(msg.sdp);
      return;
    }
    if (msg.type === 'ice' && msg.from === 'viewer') {
      const pc = peers.get(msg.viewer_channel);
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (_) {}
      }
      return;
    }
    if (msg.type === 'control' && msg.from === 'viewer') {
      try {
        await handleControl(msg);
      } catch (err) {
        console.error('control failed', err);
        sendControlAck(msg, false, err.message || String(err));
      }
    }
  }

  function nativeBridge() {
    return window.HomeBoardNative || null;
  }

  function collectState() {
    const native = nativeBridge();
    let torch = false;
    let eco = false;
    let torchAvailable = false;
    let ecoAvailable = false;
    let nativeDetect = false;
    try {
      if (native?.getCapabilities) {
        const caps = JSON.parse(native.getCapabilities() || '{}');
        torchAvailable = !!caps.torch;
        ecoAvailable = !!caps.eco;
        nativeDetect = !!caps.phone_detect;
      }
      if (native?.isTorchOn) torch = !!native.isTorchOn();
      if (native?.isEcoOn) eco = !!native.isEcoOn();
    } catch (_) { /* ignore */ }

    return {
      streaming: !!(document.getElementById('btnStop') && !document.getElementById('btnStop').disabled),
      facing: facingMode,
      dual: dualMode,
      motion: !!document.getElementById('motionEnabled')?.checked,
      record_motion: !!document.getElementById('recordOnMotion')?.checked,
      motion_settings: {
        sensitivity: motionSettings.sensitivity,
        sound_enabled: !!motionSettings.sound_enabled,
        sound_sensitivity: motionSettings.sound_sensitivity,
        sound_threshold: soundThreshold(),
        sound_level: lastSoundRms,
        cooldown_sec: motionSettings.cooldown_sec,
        interval_ms: motionSettings.interval_ms,
        sectors: motionSettings.sectors.slice(),
        threshold: motionThreshold(),
        schedule: {
          enabled: !!motionSettings.schedule?.enabled,
          days: (motionSettings.schedule?.days || defaultSchedule().days).slice(),
          start_hour: motionSettings.schedule?.start_hour ?? 0,
          end_hour: motionSettings.schedule?.end_hour ?? 24,
        },
        schedule_active: isMotionScheduleActive(),
        schedule_summary: scheduleSummary(),
      },
      torch,
      eco,
      torch_available: torchAvailable || !!native?.setTorch,
      eco_available: ecoAvailable || !!native?.setEco,
      native: !!native,
      online: ws?.readyState === WebSocket.OPEN,
      analytics: {
        enabled: !!analyticsPrefs.enabled,
        phone_assist: !!analyticsPrefs.phone_assist,
        trigger_mode: analyticsPrefs.trigger_mode || 'motion',
        native_detect: nativeDetect,
        last_classes: lastPhoneHints.map((h) => h.cls).filter(Boolean).slice(0, 6),
      },
    };
  }

  function emitState(extra = {}, viewerChannel = null) {
    if (!creds?.camera_id) {
      creds = loadCreds() || creds;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN || !creds?.camera_id) return;
    const payload = {
      type: 'camera_state',
      camera_id: creds.camera_id,
      state: { ...collectState(), ...extra },
    };
    if (viewerChannel) payload.viewer_channel = viewerChannel;
    ws.send(JSON.stringify(payload));
  }

  function sendControlAck(msg, ok, error) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !creds?.camera_id) return;
    const payload = {
      type: 'control_ack',
      camera_id: creds.camera_id,
      action: msg?.action || null,
      ok: !!ok,
      error: error || '',
      state: collectState(),
    };
    if (msg?.viewer_channel) payload.viewer_channel = msg.viewer_channel;
    ws.send(JSON.stringify(payload));
  }

  async function handleControl(msg) {
    if (!creds?.camera_id) creds = loadCreds() || creds;
    const action = msg.action;
    const value = msg.value;
    let ok = true;
    let error = '';

    try {
      if (action === 'get_state') {
        sendControlAck(msg, true, '');
        emitState({}, msg.viewer_channel);
        return;
      }
      if (action === 'flip') {
        await switchCamera();
      } else if (action === 'facing') {
        await switchCamera(value === 'user' ? 'user' : 'environment');
      } else if (action === 'dual') {
        await toggleDualMode(!!value);
        if (dualCam) dualCam.checked = dualMode;
      } else if (action === 'motion') {
        const el = document.getElementById('motionEnabled');
        if (el) el.checked = !!value;
      } else if (action === 'record_motion') {
        const el = document.getElementById('recordOnMotion');
        if (el) el.checked = !!value;
      } else if (action === 'motion_settings') {
        if (!value || typeof value !== 'object') {
          ok = false;
          error = 'Немає налаштувань Motion';
        } else {
          setMotionSettings(value);
        }
      } else if (action === 'motion_sensitivity') {
        setMotionSettings({ sensitivity: Number(value) });
      } else if (action === 'motion_sound_enabled') {
        setMotionSettings({ sound_enabled: !!value });
      } else if (action === 'motion_sound_sensitivity') {
        setMotionSettings({ sound_sensitivity: Number(value) });
      } else if (action === 'motion_cooldown') {
        setMotionSettings({ cooldown_sec: Number(value) });
      } else if (action === 'motion_interval') {
        setMotionSettings({ interval_ms: Number(value) });
      } else if (action === 'motion_sectors') {
        if (!Array.isArray(value)) {
          ok = false;
          error = 'Невірні сектори';
        } else {
          setMotionSettings({ sectors: value });
        }
      } else if (action === 'motion_schedule') {
        if (!value || typeof value !== 'object') {
          ok = false;
          error = 'Невірний розклад';
        } else {
          setMotionSettings({ schedule: value });
        }
      } else if (action === 'motion_schedule_enabled') {
        setMotionSettings({
          schedule: { ...(motionSettings.schedule || defaultSchedule()), enabled: !!value },
        });
      } else if (action === 'motion_start_hour') {
        setMotionSettings({
          schedule: { ...(motionSettings.schedule || defaultSchedule()), start_hour: Number(value) },
        });
      } else if (action === 'motion_end_hour') {
        setMotionSettings({
          schedule: { ...(motionSettings.schedule || defaultSchedule()), end_hour: Number(value) },
        });
      } else if (action === 'motion_days') {
        if (!Array.isArray(value)) {
          ok = false;
          error = 'Невірні дні';
        } else {
          setMotionSettings({
            schedule: { ...(motionSettings.schedule || defaultSchedule()), days: value },
          });
        }
      } else if (action === 'start') {
        const btn = document.getElementById('btnStart');
        if (btn && !btn.disabled) btn.click();
        else if (btn?.disabled) {
          // already started
        } else {
          setFacing(facingSelect?.value || facingMode);
          setDual(dualCam?.checked);
          await ensureMedia({ force: true });
          wsConnect();
          startMotion();
          document.getElementById('btnStart').disabled = true;
          document.getElementById('btnStop').disabled = false;
        }
      } else if (action === 'stop') {
        const btn = document.getElementById('btnStop');
        if (btn && !btn.disabled) btn.click();
      } else if (action === 'torch') {
        const native = nativeBridge();
        if (!native?.setTorch) {
          ok = false;
          error = 'Ліхтарик доступний лише в Android-додатку';
        } else {
          const r = native.setTorch(!!value);
          ok = r === true || r === 'true' || r === 1;
          if (!ok) error = 'Не вдалося ввімкнути ліхтарик (камера зайнята?)';
        }
      } else if (action === 'eco') {
        const native = nativeBridge();
        if (!native?.setEco) {
          ok = false;
          error = 'Економ-режим доступний лише в Android-додатку';
        } else {
          const r = native.setEco(!!value);
          ok = r === true || r === 'true' || r === 1;
          if (!ok) error = 'Не вдалося змінити економ-режим';
        }
      } else {
        ok = false;
        error = `Невідома команда: ${action}`;
      }
    } catch (err) {
      ok = false;
      error = err.message || String(err);
    }

    sendControlAck(msg, ok, error);
    emitState({}, msg.viewer_channel);
  }

  async function createOfferForViewer(viewerChannel) {
    try {
    await ensureMedia();
    } catch (err) {
      console.error(err);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'offer_error',
          error: err.message || 'Не вдалося відкрити камеру',
          viewer_channel: viewerChannel,
        }));
      }
      setStatus('Помилка камери');
      return;
    }
    if (!localStream || !localStream.getVideoTracks().length) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'offer_error',
          error: 'Немає відео-доріжки — натисніть Старт',
          viewer_channel: viewerChannel,
        }));
      }
      return;
    }
    if (peers.has(viewerChannel)) {
      peers.get(viewerChannel).close();
      peers.delete(viewerChannel);
    }
    const pc = new RTCPeerConnection(ICE);
    peers.set(viewerChannel, pc);
    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks().find((t) => t.readyState === 'live') || null;
    if (videoTrack) pc.addTrack(videoTrack, localStream);
    if (audioTrack) {
      pc.addTrack(audioTrack, localStream);
    } else {
      // Reserve audio m-line so mic can be attached later without full renegotiation gaps.
      pc.addTransceiver('audio', { direction: 'sendonly' });
    }
    window.HomeBoardWebRTC?.preferH264?.(pc);
    pc.onicecandidate = (ev) => {
      if (ev.candidate && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
          viewer_channel: viewerChannel,
        }));
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('Streaming');
      else if (pc.connectionState === 'failed') setStatus('WebRTC failed');
      else if (pc.connectionState === 'connecting') setStatus('Connecting…');
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'offer',
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      viewer_channel: viewerChannel,
    }));
    setStatus('Offer sent · waiting viewer');
  }

  function disconnectSoundAnalyser() {
    try { soundSource?.disconnect(); } catch (_) { /* ignore */ }
    try { soundAnalyser?.disconnect(); } catch (_) { /* ignore */ }
    soundSource = null;
    soundAnalyser = null;
    soundData = null;
    soundTrackId = null;
  }

  function ensureSoundAnalyser() {
    const track = localStream?.getAudioTracks?.()?.find((t) => t.readyState === 'live') || null;
    if (!track) {
      disconnectSoundAnalyser();
      return false;
    }
    if (soundAnalyser && soundTrackId === track.id) return true;
    disconnectSoundAnalyser();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!soundAudioCtx || soundAudioCtx.state === 'closed') {
        soundAudioCtx = new AC();
      }
      if (soundAudioCtx.state === 'suspended') {
        soundAudioCtx.resume().catch(() => {});
      }
      soundSource = soundAudioCtx.createMediaStreamSource(new MediaStream([track]));
      soundAnalyser = soundAudioCtx.createAnalyser();
      soundAnalyser.fftSize = 2048;
      soundAnalyser.smoothingTimeConstant = 0.8;
      soundSource.connect(soundAnalyser);
      soundData = new Uint8Array(soundAnalyser.fftSize);
      soundTrackId = track.id;
      return true;
    } catch (err) {
      console.warn('sound analyser', err);
      disconnectSoundAnalyser();
      return false;
    }
  }

  function measureSoundRms() {
    if (!ensureSoundAnalyser() || !soundAnalyser || !soundData) return null;
    soundAnalyser.getByteTimeDomainData(soundData);
    let sum = 0;
    for (let i = 0; i < soundData.length; i++) {
      const v = (soundData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / soundData.length);
  }

  function tickSound() {
    const rms = measureSoundRms();
    if (rms == null) {
      lastSoundRms = 0;
      const nowLabel = document.getElementById('motionSoundNowLabel');
      const fill = document.getElementById('motionSoundFill');
      if (nowLabel) nowLabel.textContent = 'н/д';
      if (fill) fill.style.width = '0%';
      if (motionSoundLiveEl) {
        motionSoundLiveEl.textContent = motionSettings?.sound_enabled
          ? 'Mic: немає аудіо в стрімі (перезапустіть Start з дозволом мікрофона)'
          : 'Mic: немає аудіо · рівень недоступний';
      }
      emitSoundLevel(0, { available: false });
      return;
    }
    lastSoundRms = rms;
    const thr = soundThreshold();
    const score = Math.round(rms * 100);
    const nowLabel = document.getElementById('motionSoundNowLabel');
    const fill = document.getElementById('motionSoundFill');
    const meter = document.getElementById('motionSoundMeter');
    if (nowLabel) nowLabel.textContent = String(score);
    if (fill) {
      const pct = Math.max(0, Math.min(100, Math.round((rms / 0.28) * 100)));
      fill.style.width = `${pct}%`;
    }
    if (meter) meter.classList.toggle('hot', rms >= thr);
    if (motionSoundLiveEl) {
      const mode = motionSettings?.sound_enabled ? 'реакція увімкнена' : 'лише індикатор';
      motionSoundLiveEl.textContent =
        `Mic: ${rms.toFixed(3)} / поріг ${thr.toFixed(3)} · ${mode}`;
    }
    emitSoundLevel(rms, { available: true, threshold: thr });

    if (!motionSettings?.sound_enabled) return;
    if (!document.getElementById('motionEnabled')?.checked) return;
    if (!isMotionScheduleActive()) return;
    if (rms > thr && Date.now() > motionCooldownUntil) {
      motionCooldownUntil = Date.now() + motionSettings.cooldown_sec * 1000;
      const snap = captureMotionSnapshot();
      onMotion(snap || document.createElement('canvas'), {
        score: rms * 100,
        thr: thr * 100,
        hot: [],
        source: 'sound',
      });
    }
  }

  let lastSoundEmitAt = 0;
  function emitSoundLevel(rms, { available = true, threshold = null } = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !creds?.camera_id) return;
    const now = Date.now();
    if (now - lastSoundEmitAt < 250) return;
    lastSoundEmitAt = now;
    ws.send(JSON.stringify({
      type: 'sound_level',
      camera_id: creds.camera_id,
      level: Number((Number(rms) || 0).toFixed(4)),
      threshold: Number((threshold != null ? threshold : soundThreshold()).toFixed(4)),
      available: !!available,
      sound_enabled: !!motionSettings?.sound_enabled,
    }));
  }

  function startSoundMonitor() {
    stopSoundMonitor();
    soundTimer = setInterval(tickSound, 200);
  }

  function stopSoundMonitor() {
    if (soundTimer) clearInterval(soundTimer);
    soundTimer = null;
  }

  function startMotion() {
    stopMotion();
    if (!motionSettings) motionSettings = loadMotionSettings();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cellW = MOTION_W / MOTION_COLS;
    const cellH = MOTION_H / MOTION_ROWS;
    const interval = motionSettings.interval_ms || 400;

    startSoundMonitor();

    motionTimer = setInterval(() => {
      if (!document.getElementById('motionEnabled')?.checked) return;
      if (!isMotionScheduleActive()) {
        if (motionLiveScoreEl) {
          motionLiveScoreEl.textContent = `Поза розкладом — фіксація вимкнена (${scheduleSummary()})`;
        }
        lastFrame = null;
        return;
      }
      const src = dualMode ? composeCanvas : localVideo;
      const ready = dualMode ? composeCanvas.width : localVideo.videoWidth;
      if (!ready) return;
      canvas.width = MOTION_W;
      canvas.height = MOTION_H;
      ctx.drawImage(src, 0, 0, MOTION_W, MOTION_H);
      const frame = ctx.getImageData(0, 0, MOTION_W, MOTION_H).data;
      if (lastFrame) {
        const sectorDiff = new Array(MOTION_COLS * MOTION_ROWS).fill(0);
        const sectorCount = new Array(MOTION_COLS * MOTION_ROWS).fill(0);
        let diff = 0;
        let samples = 0;
        for (let y = 0; y < MOTION_H; y++) {
          for (let x = 0; x < MOTION_W; x++) {
            const sector = Math.floor(x / cellW) + Math.floor(y / cellH) * MOTION_COLS;
            if (!motionSettings.sectors[sector]) continue;
            const i = (y * MOTION_W + x) * 4;
            const d = Math.abs(frame[i] - lastFrame[i]);
            diff += d;
            samples += 1;
            sectorDiff[sector] += d;
            sectorCount[sector] += 1;
          }
        }
        const score = samples ? diff / samples : 0;
        const thr = motionThreshold();
        const hot = [];
        for (let s = 0; s < sectorDiff.length; s++) {
          if (!motionSettings.sectors[s] || !sectorCount[s]) continue;
          if (sectorDiff[s] / sectorCount[s] > thr) hot.push(s);
        }
        lastHotSectors = hot;
        if (motionLiveScoreEl) {
          motionLiveScoreEl.textContent =
            `Відео: ${score.toFixed(1)} / поріг ${thr} · сектори: ${hot.map((n) => n + 1).join(',') || '—'}`;
        }
        if (motionSettings.show_overlay) renderMotionOverlay();
        else if (motionSectorGrid && !motionPanel?.hidden) renderSectorGrid();

        if (score > thr && Date.now() > motionCooldownUntil) {
          motionCooldownUntil = Date.now() + motionSettings.cooldown_sec * 1000;
          let hotSectors = hot.slice();
          if (!hotSectors.length) {
            // Diffuse motion: take top sectors by score
            hotSectors = sectorDiff
              .map((d, s) => ({
                s,
                v: sectorCount[s] ? d / sectorCount[s] : 0,
                on: !!motionSettings.sectors[s],
              }))
              .filter((x) => x.on && x.v > 0)
              .sort((a, b) => b.v - a.v)
              .slice(0, 3)
              .map((x) => x.s);
          }
          lastHotSectors = hotSectors;
          onMotion(canvas, { score, thr, hot: hotSectors, source: 'video' });
        }
      }
      lastFrame = frame;
    }, interval);
  }

  function stopMotion() {
    if (motionTimer) clearInterval(motionTimer);
    motionTimer = null;
    stopSoundMonitor();
    lastFrame = null;
  }

  async function refreshTelegramPrefs() {
    if (!creds?.camera_id || !creds?.device_token) return;
    try {
      const res = await fetch('/integration/api/device/prefs/', {
        headers: {
          'X-Camera-Id': creds.camera_id,
          'X-Device-Token': creds.device_token,
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      telegramPrefs = {
        telegram_enabled: !!data.telegram_enabled,
        send_screenshot: data.send_screenshot !== false,
        jpeg_quality: Math.min(0.95, Math.max(0.2, Number(data.jpeg_quality) || 0.7)),
        max_width: Number(data.max_width) || 1280,
      };
    } catch (_) { /* ignore */ }
  }

  async function refreshAnalyticsPrefs() {
    if (!creds?.camera_id || !creds?.device_token) return;
    try {
      const res = await fetch('/analytics/api/device/settings/', {
        headers: {
          'X-Camera-Id': creds.camera_id,
          'X-Device-Token': creds.device_token,
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      analyticsPrefs = {
        enabled: !!data.enabled,
        phone_assist: !!data.phone_assist,
        trigger_mode: data.trigger_mode || 'motion',
        fps: Math.max(0.5, Math.min(2, Number(data.fps) || 1)),
        classes: Array.isArray(data.classes) ? data.classes : analyticsPrefs.classes,
      };
      if (analyticsPrefs.phone_assist) {
        window.HomeBoardPhoneAI?.ensure?.(analyticsPrefs.classes);
      }
      updateAiStatusUi();
      syncAnalyticsTimer();
    } catch (_) { /* ignore */ }
  }

  function syncAnalyticsTimer() {
    if (analyticsTimer) {
      clearInterval(analyticsTimer);
      analyticsTimer = null;
    }
    if (!analyticsPrefs.enabled || analyticsPrefs.trigger_mode !== 'continuous') return;
    const ms = Math.max(500, Math.round(1000 / analyticsPrefs.fps));
    analyticsTimer = setInterval(() => {
      uploadAnalyticsFrame({ source: 'continuous' }).catch(() => {});
    }, ms);
  }

  async function uploadAnalyticsFrame({ source = 'motion', motionEventId = null } = {}) {
    if (!analyticsPrefs.enabled || !creds?.camera_id || !creds?.device_token) return null;
    const gap = 1000 / Math.max(0.5, analyticsPrefs.fps || 1);
    if (Date.now() - lastAnalyticsUploadAt < gap - 20) return null;
    const snap = captureMotionSnapshot();
    if (!snap) return null;

    let phoneHints = [];
    if (analyticsPrefs.phone_assist && window.HomeBoardPhoneAI?.detect) {
      try {
        phoneHints = await window.HomeBoardPhoneAI.detect(snap, analyticsPrefs.classes) || [];
      } catch (_) {
        phoneHints = [];
      }
      // If assist is on and nothing interesting — skip continuous uploads
      if (source === 'continuous' && (!phoneHints || !phoneHints.length)) {
        drawAiOverlay([], snap);
        return null;
      }
    } else {
      drawAiOverlay([], snap);
    }

    lastPhoneHints = phoneHints || [];
    drawAiOverlay(lastPhoneHints, snap);

    const blob = await new Promise((r) => snap.toBlob(r, 'image/jpeg', 0.72));
    if (!blob) return null;
    const fd = new FormData();
    fd.append('frame', blob, `ai-${Date.now()}.jpg`);
    fd.append('source', source);
    if (motionEventId) fd.append('motion_event_id', String(motionEventId));
    if (phoneHints.length) fd.append('phone_hints', JSON.stringify(phoneHints));
    lastAnalyticsUploadAt = Date.now();
    const res = await fetch('/analytics/api/frame/', {
      method: 'POST',
      headers: {
        'X-Camera-Id': creds.camera_id,
        'X-Device-Token': creds.device_token,
      },
      body: fd,
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  function updateAiStatusUi() {
    const el = document.getElementById('aiStatus');
    const native = (() => {
      try {
        return !!JSON.parse(nativeBridge()?.getCapabilities?.() || '{}').phone_detect;
      } catch {
        return false;
      }
    })();
    if (el) {
      if (!analyticsPrefs.enabled) {
        el.hidden = true;
      } else {
        el.hidden = false;
        el.textContent = analyticsPrefs.phone_assist
          ? (native ? 'AI · телефон' : 'AI · on-device')
          : 'AI · сервер';
      }
    }
    if (!analyticsPrefs.enabled || !analyticsPrefs.phone_assist) {
      drawAiOverlay([], null);
    }
    try {
      nativeBridge()?.onAnalyticsStatus?.(JSON.stringify({
        enabled: !!analyticsPrefs.enabled,
        phone_assist: !!analyticsPrefs.phone_assist,
        trigger_mode: analyticsPrefs.trigger_mode || 'motion',
      }));
    } catch (_) { /* ignore */ }
  }

  function drawAiOverlay(hints, srcCanvas) {
    const ov = document.getElementById('aiOverlay');
    if (!ov) return;
    const list = Array.isArray(hints) ? hints : [];
    const w = srcCanvas?.width || 0;
    const h = srcCanvas?.height || 0;
    if (!w || !h || !list.length) {
      ov.hidden = true;
      const ctxEmpty = ov.getContext('2d');
      if (ctxEmpty && ov.width && ov.height) ctxEmpty.clearRect(0, 0, ov.width, ov.height);
      return;
    }
    ov.hidden = false;
    ov.width = w;
    ov.height = h;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${Math.max(12, Math.round(w / 42))}px sans-serif`;
    ctx.lineWidth = Math.max(2, w / 360);
    list.forEach((p) => {
      const box = p.xyxy || [];
      if (box.length < 4) return;
      const x = Number(box[0]) || 0;
      const y = Number(box[1]) || 0;
      const bw = (Number(box[2]) || 0) - x;
      const bh = (Number(box[3]) || 0) - y;
      ctx.strokeStyle = 'rgba(61,214,198,0.95)';
      ctx.strokeRect(x, y, bw, bh);
      const label = `${p.cls || '?'} ${Math.round((Number(p.conf) || 0) * 100)}%`;
      const tw = ctx.measureText(label).width + 8;
      const th = Math.max(16, Math.round(w / 38));
      const ly = Math.max(0, y - th);
      ctx.fillStyle = 'rgba(11,15,20,0.75)';
      ctx.fillRect(x, ly, tw, th);
      ctx.fillStyle = '#3DD6C6';
      ctx.fillText(label, x + 4, ly + th - 4);
    });
  }

  function captureMotionSnapshot() {
    const src = dualMode ? composeCanvas : localVideo;
    const sw = dualMode ? (composeCanvas.width || 0) : (localVideo.videoWidth || 0);
    const sh = dualMode ? (composeCanvas.height || 0) : (localVideo.videoHeight || 0);
    if (!sw || !sh) return null;
    const maxW = telegramPrefs.max_width || 1280;
    const scale = Math.min(1, maxW / sw);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const snap = document.createElement('canvas');
    snap.width = w;
    snap.height = h;
    const ctx = snap.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    return snap;
  }

  async function onMotion(canvas, meta = {}) {
    const source = meta.source === 'sound' ? 'sound' : 'video';
    const hot = Array.isArray(meta.hot) ? meta.hot.map((n) => Number(n)).filter((n) => n >= 0) : [];
    const hotLabel = hot.map((n) => n + 1).join(',') || '—';
    setStatus(
      source === 'sound'
        ? `Sound! ${(meta.score || 0).toFixed(0)}`
        : `Motion! s${(meta.score || 0).toFixed(0)} [${hotLabel}]`,
    );
    const snap = (source === 'sound' ? captureMotionSnapshot() : null) || canvas || captureMotionSnapshot();
    const quality = telegramPrefs.jpeg_quality || 0.7;
    let blob = null;
    if (snap && telegramPrefs.send_screenshot !== false && typeof snap.toBlob === 'function') {
      blob = await new Promise((r) => snap.toBlob(r, 'image/jpeg', quality));
    }
    const fd = new FormData();
    fd.append(
      'note',
      source === 'sound'
        ? `auto source=sound level=${(meta.score || 0).toFixed(1)} thr=${meta.thr || (soundThreshold() * 100)}`
        : `auto source=video score=${(meta.score || 0).toFixed(1)} thr=${meta.thr || motionThreshold()} sectors=${hotLabel}`,
    );
    fd.append('score', String(meta.score || 0));
    fd.append('threshold', String(meta.thr || (source === 'sound' ? soundThreshold() * 100 : motionThreshold())));
    fd.append('sectors', JSON.stringify(hot));
    fd.append('source', source);
    if (blob) fd.append('thumbnail', blob, 'motion.jpg');
    const res = await fetch('/motion/api/report/', {
      method: 'POST',
      headers: {
        'X-Camera-Id': creds.camera_id,
        'X-Device-Token': creds.device_token,
      },
      body: fd,
    });
    if (res.ok) {
      const data = await res.json();
      lastMotionEventId = data.event_id;
    }
    uploadAnalyticsFrame({
      source: source === 'sound' ? 'sound' : 'motion',
      motionEventId: lastMotionEventId,
    }).catch(() => {});
    if (document.getElementById('recordOnMotion').checked) {
      startClipRecording();
    }
    setTimeout(() => setStatus('Streaming'), 1500);
  }

  async function startClipRecording() {
    if (motionRecording || !localStream) return;
    recordedChunks = [];
    const mime = window.HomeBoardLocalStore?.pickMime?.()
      || (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
        : 'video/webm');
    motionRecorder = new MediaRecorder(localStream, { mimeType: mime });
    motionRecorder.ondataavailable = (e) => {
      if (e.data.size) recordedChunks.push(e.data);
    };
    motionRecorder.onstop = uploadClip;
    motionRecorder.start(1000);
    motionRecording = true;
    setTimeout(() => {
      if (motionRecording && motionRecorder?.state === 'recording') motionRecorder.stop();
    }, 12000);
  }

  async function uploadClip() {
    motionRecording = false;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const fd = new FormData();
    fd.append('file', blob, `clip-${Date.now()}.webm`);
    fd.append('trigger', analyticsPrefs.enabled ? 'detection' : 'motion');
    if (lastMotionEventId) fd.append('motion_event_id', lastMotionEventId);
    if (lastDetectionEventId) fd.append('detection_event_id', lastDetectionEventId);
    await fetch('/recordings/api/upload/', {
      method: 'POST',
      headers: {
        'X-Camera-Id': creds.camera_id,
        'X-Device-Token': creds.device_token,
      },
      body: fd,
    });
  }

  function hardStopMedia() {
    stopMotion();
    if (analyticsTimer) {
      clearInterval(analyticsTimer);
      analyticsTimer = null;
    }
    disconnectSoundAnalyser();
    stopCompose();
    if (loopRecorder?.active) {
      loopRecorder.stop().catch(() => {});
    }
    if (motionRecorder && motionRecording) {
      try { motionRecorder.stop(); } catch (_) {}
    }
    const tracks = new Set();
    [rawMain, rawPip, localStream].forEach((stream) => {
      stream?.getTracks().forEach((t) => tracks.add(t));
    });
    tracks.forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    rawMain = null;
    rawPip = null;
    localStream = null;
    localVideo.srcObject = null;
    pipVideo.srcObject = null;
    previewWrap.classList.remove('dual-mode');
    composeCanvas.hidden = true;
    localVideo.hidden = false;
    drawAiOverlay([], null);
    lastPhoneHints = [];
  }

  document.getElementById('btnPair').onclick = async () => {
    const code = document.getElementById('pairCode').value.trim().toUpperCase();
    if (!code) {
      alert('Введіть код з ПК (Камери → Створити код)');
      return;
    }
    const res = await fetch('/cameras/api/pair/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      alert(data.error || 'Помилка pairing');
      return;
    }
    saveCreds(data);
    showLive();
  };

  facingSelect?.addEventListener('change', async () => {
    await switchCamera(facingSelect.value);
  });

  dualCam?.addEventListener('change', async () => {
    await toggleDualMode(dualCam.checked);
  });

  localLoopEl?.addEventListener('change', async () => {
    wantLocalLoop = !!localLoopEl.checked;
    localStorage.setItem(LOCAL_LOOP_KEY, wantLocalLoop ? '1' : '0');
    updateFacingUi();
    await syncLocalLoop();
  });

  localMaxMbEl?.addEventListener('change', async () => {
    localStorage.setItem(LOCAL_MAX_KEY, localMaxMbEl.value);
    await ensureLoopRecorder()?.refreshUsage();
    if (loopRecorder?.active) {
      await window.HomeBoardLocalStore.enforceQuota(getLocalMaxBytes(), creds?.camera_id || null);
      await loopRecorder.refreshUsage();
    }
  });

  function syncMotionFromInputs() {
    setMotionSettings({
      sensitivity: Number(motionSensEl?.value || motionSettings.sensitivity),
      sound_enabled: !!motionSoundEnabledEl?.checked,
      sound_sensitivity: Number(motionSoundSensEl?.value || motionSettings.sound_sensitivity),
      cooldown_sec: Number(motionCdEl?.value || motionSettings.cooldown_sec),
      interval_ms: Number(motionIntervalEl?.value || motionSettings.interval_ms),
      show_overlay: !!motionShowOverlayEl?.checked,
      sectors: motionSettings.sectors.slice(),
      schedule: {
        enabled: !!document.getElementById('motionScheduleEnabled')?.checked,
        days: (motionSettings.schedule?.days || defaultSchedule().days).slice(),
        start_hour: Number(document.getElementById('motionStartHour')?.value || 0),
        end_hour: Number(document.getElementById('motionEndHour')?.value || 24),
      },
    });
    emitState();
  }

  btnMotionSettings?.addEventListener('click', () => {
    if (!motionPanel) return;
    motionPanel.hidden = !motionPanel.hidden;
    if (!motionPanel.hidden) applyMotionSettingsToUi();
  });
  btnMotionClose?.addEventListener('click', () => {
    if (motionPanel) motionPanel.hidden = true;
  });
  motionSensEl?.addEventListener('input', () => {
    document.getElementById('motionSensLabel').textContent = motionSensEl.value;
  });
  motionSensEl?.addEventListener('change', syncMotionFromInputs);
  motionSoundEnabledEl?.addEventListener('change', syncMotionFromInputs);
  motionSoundSensEl?.addEventListener('input', () => {
    const el = document.getElementById('motionSoundSensLabel');
    if (el) el.textContent = motionSoundSensEl.value;
  });
  motionSoundSensEl?.addEventListener('change', syncMotionFromInputs);
  motionCdEl?.addEventListener('input', () => {
    document.getElementById('motionCdLabel').textContent = motionCdEl.value;
  });
  motionCdEl?.addEventListener('change', syncMotionFromInputs);
  motionIntervalEl?.addEventListener('input', () => {
    document.getElementById('motionIntervalLabel').textContent = motionIntervalEl.value;
  });
  motionIntervalEl?.addEventListener('change', syncMotionFromInputs);
  motionShowOverlayEl?.addEventListener('change', syncMotionFromInputs);
  document.getElementById('motionScheduleEnabled')?.addEventListener('change', syncMotionFromInputs);
  document.getElementById('motionStartHour')?.addEventListener('change', syncMotionFromInputs);
  document.getElementById('motionEndHour')?.addEventListener('change', syncMotionFromInputs);
  document.getElementById('btnSectorsAll')?.addEventListener('click', () => {
    setMotionSettings({ sectors: Array(MOTION_COLS * MOTION_ROWS).fill(true) });
    emitState();
  });
  document.getElementById('btnSectorsNone')?.addEventListener('click', () => {
    setMotionSettings({ sectors: Array(MOTION_COLS * MOTION_ROWS).fill(false) });
    emitState();
  });
  applyMotionSettingsToUi();

  btnLocalList?.addEventListener('click', async () => {
    if (!localPanel) return;
    localPanel.hidden = !localPanel.hidden;
    if (!localPanel.hidden) await renderLocalList();
  });

  btnLocalClear?.addEventListener('click', async () => {
    if (!confirm('Видалити всі локальні сегменти на цьому пристрої?')) return;
    await window.HomeBoardLocalStore.clearAll(creds?.camera_id || null);
    if (localPlayer) localPlayer.removeAttribute('src');
    await renderLocalList();
    await ensureLoopRecorder()?.refreshUsage();
  });

  btnFlip.onclick = async () => {
    await switchCamera();
  };

  document.getElementById('btnStart').onclick = async () => {
    try {
      setFacing(facingSelect?.value || facingMode);
      setDual(dualCam?.checked);
      wantLocalLoop = !!localLoopEl?.checked;
      localStorage.setItem(LOCAL_LOOP_KEY, wantLocalLoop ? '1' : '0');
      setStatus('Запит камери…');
      await ensureMedia({ force: true });
      setStatus('Підключення…');
      wsConnect();
      startMotion();
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').disabled = false;
      await syncLocalLoop();
      await refreshTelegramPrefs();
      await refreshAnalyticsPrefs();
      emitState();
    } catch (err) {
      console.error(err);
      setStatus('Помилка камери');
      alert(err.message || String(err));
    }
  };

  document.getElementById('btnStop').onclick = async () => {
    peers.forEach((pc) => pc.close());
    peers.clear();
    ws?.close();
    if (loopRecorder?.active) {
      try { await loopRecorder.stop(); } catch (_) {}
    }
    hardStopMedia();
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    setStatus('Зупинено');
    await ensureLoopRecorder()?.refreshUsage();
    emitState();
  };

  document.getElementById('btnReset').onclick = () => {
    localStorage.removeItem(STORAGE_KEY);
    creds = null;
    pairForm.hidden = false;
    liveControls.hidden = true;
    document.getElementById('pairCode').value = '';
    setStatus('Не підключено');
  };

  function showLive() {
    pairForm.hidden = true;
    liveControls.hidden = false;
    camName.textContent = creds.name || '';
    updateFacingUi();
    setStatus('Готово до стріму');
    ensureLoopRecorder()?.refreshUsage();
    refreshTelegramPrefs();
    refreshAnalyticsPrefs();
    maybeAutostart();
  }

  let autostartTried = false;
  function maybeAutostart() {
    if (autostartTried || !isAndroidApp()) return;
    if (!creds?.camera_id) return;
    const btn = document.getElementById('btnStart');
    if (!btn || btn.disabled) return;
    autostartTried = true;
    setStatus('Автостарт камери…');
    // Невелика затримка: WebView встигає видати PermissionRequest
    setTimeout(() => {
      try { btn.click(); } catch (e) { console.error(e); }
    }, 400);
  }

  applyMirror();
  updateFacingUi();
  polyfillMediaDevices();

  // Android WebView injects credentials after page load — accept late updates.
  window.HomeBoardSetCreds = (data) => {
    if (!data?.camera_id || !data?.device_token) return;
    saveCreds(data);
    showLive();
  };

  creds = loadCreds();
  if (creds?.camera_id && creds?.device_token) showLive();
  else ensureLoopRecorder()?.refreshUsage();

  setInterval(() => {
    if (creds?.camera_id && creds?.device_token) {
      refreshAnalyticsPrefs();
    }
  }, 20000);

  const hint = document.getElementById('secure-hint');
  if (hint && !window.isSecureContext) {
    hint.hidden = false;
    hint.innerHTML = 'Для камери потрібен HTTPS: відкрийте <strong>https://' + location.host + '/camera/</strong> і дозвольте сертифікат.';
  } else if (hint && isAndroidApp()) {
    hint.hidden = false;
    hint.textContent = 'Android-додаток: дозвольте камеру/мікрофон у системному вікні, далі стрім стартує автоматично.';
  }
})();
