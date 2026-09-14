(() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const STORAGE_KEY = 'homeboard_camera';
  const FACING_KEY = 'homeboard_facing';
  const DUAL_KEY = 'homeboard_dual';
  const LOCAL_LOOP_KEY = 'homeboard_local_loop';
  const LOCAL_MAX_KEY = 'homeboard_local_max_mb';

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

  let creds = null;
  let localStream = null; // outbound stream (single cam or canvas+audio)
  let rawMain = null;
  let rawPip = null;
  let ws = null;
  let peers = new Map();
  let motionTimer = null;
  let composeTimer = null;
  let lastFrame = null;
  let recordedChunks = [];
  let lastMotionEventId = null;
  let motionCooldownUntil = 0;
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

  async function openCamera(facing, { withAudio = false } = {}) {
    assertSecure();
    const mode = facing === 'user' ? 'user' : 'environment';
    // На Android WebView `exact` часто падає — спочатку мʼякі обмеження
    const videoConstraints = isAndroidApp()
      ? [
          true,
          { facingMode: mode },
          { facingMode: { ideal: mode } },
          { width: { ideal: 1280 }, height: { ideal: 720 } },
        ]
      : [
          { facingMode: { ideal: mode } },
          { facingMode: mode },
          { facingMode: { exact: mode } },
          true,
        ];
    let lastErr;
    for (const video of videoConstraints) {
      for (const audio of withAudio ? [true, false] : [false]) {
        try {
          return await navigator.mediaDevices.getUserMedia({ video, audio });
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

  async function publishOutbound(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Немає відео-доріжки');

    localStream = stream;
    for (const pc of peers.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(videoTrack); } catch (err) { console.warn(err); }
      }
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      const audioTrack = stream.getAudioTracks()[0] || null;
      if (audioSender && audioTrack) {
        try { await audioSender.replaceTrack(audioTrack); } catch (err) { console.warn(err); }
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
    // environment -> localVideo, user -> pipVideo; audio from front (usually nearer to user) or env
    let envStream;
    let userStream;
    try {
      envStream = await openCamera('environment', { withAudio: false });
      userStream = await openCamera('user', { withAudio: true });
    } catch (err) {
      stopStream(envStream);
      stopStream(userStream);
      throw new Error(
        'Цей пристрій не дозволяє дві камери одночасно. ' +
        (err.message || String(err))
      );
    }

    stopStream(rawMain);
    stopStream(rawPip);
    stopCompose();
    // Stop previous outbound canvas tracks
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => {
        if (t.label === 'canvas' || t.readyState === 'live') {
          // stop only canvas-derived later after replace
        }
      });
    }

    rawMain = envStream;
    rawPip = userStream;
    localVideo.srcObject = envStream;
    pipVideo.srcObject = userStream;
    localVideo.muted = true;
    pipVideo.muted = true;
    try { await localVideo.play(); } catch (_) {}
    try { await pipVideo.play(); } catch (_) {}

    // Wait briefly for dimensions
    await new Promise((r) => setTimeout(r, 250));
    startComposeLoop();

    const canvasStream = composeCanvas.captureStream(24);
    const audioTrack =
      userStream.getAudioTracks()[0] ||
      envStream.getAudioTracks()[0] ||
      null;
    const outbound = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioTrack ? [audioTrack] : []),
    ]);

    // Stop old outbound video tracks if any (not raw cams)
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => {
        if (!rawMain.getVideoTracks().includes(t) && !rawPip.getVideoTracks().includes(t)) {
          t.stop();
        }
      });
    }

    await publishOutbound(outbound);
    applyMirror();
    updateFacingUi();
    return outbound;
  }

  async function startSingleMedia() {
    stopCompose();
    previewWrap.classList.remove('dual-mode');
    composeCanvas.hidden = true;
    pipVideo.hidden = true;
    localVideo.hidden = false;

    stopStream(rawPip);
    rawPip = null;
    const stream = await openCamera(facingMode, { withAudio: true });
    stopStream(rawMain);
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
    setFacing(target);
    if (!localStream && !rawMain) return;

    try {
      if (dualMode) {
        // Only swap main/PiP roles — both already open
        setStatus(target === 'user' ? 'Головна: фронтальна' : 'Головна: задня');
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
      setStatus('Не вдалося змінити камеру');
      alert(err.message || String(err));
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
        stopStream(rawPip);
        rawPip = null;
        stopCompose();
        await startSingleMedia();
      }
      setStatus(peers.size ? 'Streaming' : (ws?.readyState === WebSocket.OPEN ? 'Online · очікування viewer' : 'Готово до стріму'));
    } catch (err) {
      console.error(err);
      setDual(was);
      setStatus('Dual camera недоступна');
      alert(err.message || String(err));
    }
  }

  function wsConnect() {
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
    const msg = JSON.parse(evt.data);
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
      await handleControl(msg);
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
    try {
      if (native?.getCapabilities) {
        const caps = JSON.parse(native.getCapabilities() || '{}');
        torchAvailable = !!caps.torch;
        ecoAvailable = !!caps.eco;
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
      torch,
      eco,
      torch_available: torchAvailable || !!native?.setTorch,
      eco_available: ecoAvailable || !!native?.setEco,
      native: !!native,
      online: ws?.readyState === WebSocket.OPEN,
    };
  }

  function emitState(extra = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !creds?.camera_id) return;
    ws.send(JSON.stringify({
      type: 'camera_state',
      camera_id: creds.camera_id,
      state: { ...collectState(), ...extra },
    }));
  }

  async function handleControl(msg) {
    const action = msg.action;
    const value = msg.value;
    let ok = true;
    let error = '';

    try {
      if (action === 'get_state') {
        emitState();
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

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'control_ack',
        camera_id: creds.camera_id,
        action,
        ok,
        error,
        state: collectState(),
      }));
    }
    emitState();
  }

  async function createOfferForViewer(viewerChannel) {
    await ensureMedia();
    if (peers.has(viewerChannel)) {
      peers.get(viewerChannel).close();
      peers.delete(viewerChannel);
    }
    const pc = new RTCPeerConnection(ICE);
    peers.set(viewerChannel, pc);
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
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

  function startMotion() {
    stopMotion();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    motionTimer = setInterval(() => {
      if (!document.getElementById('motionEnabled').checked) return;
      const src = dualMode ? composeCanvas : localVideo;
      const ready = dualMode ? composeCanvas.width : localVideo.videoWidth;
      if (!ready) return;
      canvas.width = 64;
      canvas.height = 36;
      ctx.drawImage(src, 0, 0, 64, 36);
      const frame = ctx.getImageData(0, 0, 64, 36).data;
      if (lastFrame) {
        let diff = 0;
        for (let i = 0; i < frame.length; i += 4) {
          diff += Math.abs(frame[i] - lastFrame[i]);
        }
        const score = diff / (frame.length / 4);
        if (score > 18 && Date.now() > motionCooldownUntil) {
          motionCooldownUntil = Date.now() + 8000;
          onMotion(canvas);
        }
      }
      lastFrame = frame;
    }, 400);
  }

  function stopMotion() {
    if (motionTimer) clearInterval(motionTimer);
    motionTimer = null;
    lastFrame = null;
  }

  async function onMotion(canvas) {
    setStatus('Motion!');
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.7));
    const fd = new FormData();
    fd.append('note', 'auto');
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
    fd.append('trigger', 'motion');
    if (lastMotionEventId) fd.append('motion_event_id', lastMotionEventId);
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
  creds = loadCreds();
  if (creds?.camera_id && creds?.device_token) showLive();
  else ensureLoopRecorder()?.refreshUsage();

  const hint = document.getElementById('secure-hint');
  if (hint && !window.isSecureContext) {
    hint.hidden = false;
    hint.innerHTML = 'Для камери потрібен HTTPS: відкрийте <strong>https://' + location.host + '/camera/</strong> і дозвольте сертифікат.';
  } else if (hint && isAndroidApp()) {
    hint.hidden = false;
    hint.textContent = 'Android-додаток: дозвольте камеру/мікрофон у системному вікні, далі стрім стартує автоматично.';
  }
})();
