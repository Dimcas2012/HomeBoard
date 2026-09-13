(() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const STORAGE_KEY = 'homeboard_camera';

  const statusEl = document.getElementById('status');
  const pairForm = document.getElementById('pair-form');
  const liveControls = document.getElementById('live-controls');
  const localVideo = document.getElementById('localVideo');
  const camName = document.getElementById('camName');

  let creds = null;
  let localStream = null;
  let ws = null;
  let peers = new Map(); // viewer_channel -> RTCPeerConnection
  let motionTimer = null;
  let lastFrame = null;
  let recording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let lastMotionEventId = null;
  let motionCooldownUntil = 0;

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

  async function ensureMedia() {
    if (localStream) return localStream;
    if (!window.isSecureContext) {
      throw new Error(
        'Потрібен HTTPS. Відкрийте https://' + location.host + '/camera/ і підтвердіть сертифікат.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Камера недоступна в цьому браузері');
    }
    const attempts = [
      { video: { facingMode: { ideal: 'environment' } }, audio: true },
      { video: true, audio: true },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const constraints of attempts) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!localStream) {
      throw lastErr || new Error('Не вдалося відкрити камеру');
    }
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.setAttribute('playsinline', 'true');
    try { await localVideo.play(); } catch (_) { /* autoplay policy */ }
    return localStream;
  }

  function wsConnect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/signal/?role=camera&camera_id=${encodeURIComponent(creds.camera_id)}&token=${encodeURIComponent(creds.device_token)}`;
    ws = new WebSocket(url);
    ws.onopen = () => setStatus('Online · очікування viewer');
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
    }
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
          candidate: ev.candidate,
          viewer_channel: viewerChannel,
        }));
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'offer',
      sdp: pc.localDescription,
      viewer_channel: viewerChannel,
    }));
    setStatus('Streaming');
  }

  // --- Motion detection via canvas frame diff ---
  function startMotion() {
    stopMotion();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    motionTimer = setInterval(() => {
      if (!document.getElementById('motionEnabled').checked) return;
      if (!localVideo.videoWidth) return;
      canvas.width = 64;
      canvas.height = 36;
      ctx.drawImage(localVideo, 0, 0, 64, 36);
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
    if (recording || !localStream) return;
    recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
    mediaRecorder = new MediaRecorder(localStream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = uploadClip;
    mediaRecorder.start(1000);
    recording = true;
    setTimeout(() => {
      if (recording && mediaRecorder?.state === 'recording') mediaRecorder.stop();
    }, 12000);
  }

  async function uploadClip() {
    recording = false;
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

  document.getElementById('btnStart').onclick = async () => {
    try {
      setStatus('Запит камери…');
      await ensureMedia();
      setStatus('Підключення…');
      wsConnect();
      startMotion();
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').disabled = false;
    } catch (err) {
      console.error(err);
      setStatus('Помилка камери');
      alert(err.message || String(err));
    }
  };

  document.getElementById('btnStop').onclick = () => {
    stopMotion();
    if (mediaRecorder && recording) mediaRecorder.stop();
    peers.forEach((pc) => pc.close());
    peers.clear();
    ws?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    setStatus('Зупинено');
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
    setStatus('Готово до стріму');
  }

  creds = loadCreds();
  if (creds?.camera_id && creds?.device_token) showLive();

  const hint = document.getElementById('secure-hint');
  if (hint && !window.isSecureContext) {
    hint.hidden = false;
    hint.innerHTML = 'Для камери на iPhone потрібен HTTPS: відкрийте <strong>https://' + location.host + '/camera/</strong> і дозвольте сертифікат.';
  }
})();
