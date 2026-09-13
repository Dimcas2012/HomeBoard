(() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const grid = document.getElementById('camera-grid');
  const toasts = document.getElementById('toasts');
  const peers = new Map(); // cameraId -> { pc, watchTimer }
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/signal/?role=viewer`;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function beep() {
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.start();
      o.stop(audioCtx.currentTime + 0.18);
    } catch (_) { /* ignore */ }
  }

  function sdpPayload(desc) {
    if (!desc) return null;
    return { type: desc.type, sdp: desc.sdp };
  }

  function tile(cameraId) {
    return grid.querySelector(`.tile[data-camera-id="${cameraId}"]`);
  }

  function setPlaceholder(el, text, hidden = false) {
    const ph = el?.querySelector('.placeholder');
    if (!ph) return;
    ph.hidden = hidden;
    if (text != null) ph.textContent = text;
  }

  function ensureTile(cam) {
    let el = tile(cam.id || cam.camera_id);
    if (el) return el;
    const id = cam.id || cam.camera_id;
    el = document.createElement('div');
    el.className = 'tile';
    el.dataset.cameraId = id;
    el.dataset.source = cam.source_type || 'browser';
    el.dataset.whep = cam.webrtc_play_url || '';
    el.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="placeholder">Офлайн</div>
      <div class="tile-meta">
        <span><span class="dot"></span>${cam.name || 'Camera'}</span>
        <span class="muted">${cam.source_type || 'browser'}</span>
      </div>`;
    grid.querySelector('.empty')?.remove();
    grid.appendChild(el);
    bindTile(el);
    return el;
  }

  async function playWhep(el) {
    const url = el.dataset.whep;
    if (!url) return;
    const video = el.querySelector('video');
    const pc = new RTCPeerConnection(ICE);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      video.srcObject = ev.streams[0];
      setPlaceholder(el, null, true);
      el.querySelector('.dot').classList.add('on');
      video.play().catch(() => {});
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!res.ok) {
      setPlaceholder(el, 'MediaMTX offline', false);
      return;
    }
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    peers.set(el.dataset.cameraId, { pc, watchTimer: null });
  }

  function closePeer(cameraId) {
    const entry = peers.get(cameraId);
    if (!entry) return;
    if (entry.watchTimer) clearTimeout(entry.watchTimer);
    try { entry.pc.close(); } catch (_) {}
    peers.delete(cameraId);
  }

  async function watchBrowserCamera(cameraId, { force = false } = {}) {
    if (!force && peers.has(cameraId)) return;
    closePeer(cameraId);

    const el = tile(cameraId);
    if (el) setPlaceholder(el, 'Підключення…', false);

    const pc = new RTCPeerConnection(ICE);

    pc.ontrack = (ev) => {
      const t = tile(cameraId);
      if (!t) return;
      const video = t.querySelector('video');
      video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      setPlaceholder(t, null, true);
      t.querySelector('.dot').classList.add('on');
      video.play().catch(() => {});
      const entry = peers.get(cameraId);
      if (entry?.watchTimer) {
        clearTimeout(entry.watchTimer);
        entry.watchTimer = null;
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const t = tile(cameraId);
      if (!t) return;
      if (state === 'failed' || state === 'disconnected') {
        setPlaceholder(t, 'Зʼєднання втрачено', false);
        // one automatic retry
        if (state === 'failed') {
          setTimeout(() => watchBrowserCamera(cameraId, { force: true }), 1500);
        }
      } else if (state === 'connecting') {
        setPlaceholder(t, 'Підключення…', false);
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          camera_id: cameraId,
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        }));
      }
    };

    const watchTimer = setTimeout(() => {
      const t = tile(cameraId);
      if (t && !t.querySelector('video').srcObject) {
        setPlaceholder(t, 'Немає відео — натисніть плитку для повтору', false);
      }
    }, 12000);

    peers.set(cameraId, { pc, watchTimer });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watch', camera_id: cameraId }));
    }
  }

  function bindTile(el) {
    el.addEventListener('click', () => {
      const video = el.querySelector('video');
      if (el.dataset.source === 'browser' && !video?.srcObject) {
        watchBrowserCamera(el.dataset.cameraId, { force: true });
        return;
      }
      el.classList.toggle('fullscreen');
    });
  }

  grid.querySelectorAll('.tile').forEach(bindTile);

  let ws = new WebSocket(wsUrl());

  function connectWs() {
    ws = new WebSocket(wsUrl());
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = () => setTimeout(connectWs, 2000);
  }

  function onOpen() {
    grid.querySelectorAll('.tile').forEach((el) => {
      if (el.dataset.source === 'rtsp') playWhep(el);
      else if (el.dataset.source === 'browser' && el.querySelector('.dot.on')) {
        watchBrowserCamera(el.dataset.cameraId, { force: true });
      }
    });
  }

  async function onMessage(evt) {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'camera_list') {
      for (const cam of msg.cameras || []) {
        const el = ensureTile(cam);
        el.querySelector('.dot').classList.toggle('on', !!cam.is_online);
        if (cam.source_type === 'rtsp') playWhep(el);
        else if (cam.is_online) watchBrowserCamera(cam.id, { force: true });
        else {
          setPlaceholder(el, 'Офлайн', false);
          closePeer(cam.id);
        }
      }
      return;
    }

    if (msg.type === 'camera_online') {
      const el = ensureTile(msg);
      el.querySelector('.dot').classList.add('on');
      setPlaceholder(el, 'Підключення…', false);
      watchBrowserCamera(msg.camera_id, { force: true });
      return;
    }

    if (msg.type === 'camera_offline') {
      const el = tile(msg.camera_id);
      if (el) {
        el.querySelector('.dot').classList.remove('on');
        setPlaceholder(el, 'Офлайн', false);
        const v = el.querySelector('video');
        v.srcObject = null;
      }
      closePeer(msg.camera_id);
      return;
    }

    if (msg.type === 'offer' && msg.from === 'camera') {
      const entry = peers.get(msg.camera_id);
      if (!entry) return;
      try {
        await entry.pc.setRemoteDescription(msg.sdp);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        ws.send(JSON.stringify({
          type: 'answer',
          camera_id: msg.camera_id,
          sdp: sdpPayload(entry.pc.localDescription),
          viewer_channel: msg.viewer_channel,
        }));
      } catch (err) {
        console.error('offer/answer failed', err);
        setPlaceholder(tile(msg.camera_id), 'Помилка WebRTC', false);
      }
      return;
    }

    if (msg.type === 'ice' && msg.from === 'camera') {
      const entry = peers.get(msg.camera_id);
      if (entry && msg.candidate) {
        try { await entry.pc.addIceCandidate(msg.candidate); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'motion') {
      beep();
      toast(`Рух: ${msg.camera_name || msg.camera_id}`);
      const el = tile(msg.camera_id);
      if (el) {
        el.classList.add('motion');
        setTimeout(() => el.classList.remove('motion'), 4000);
      }
    }
  }

  ws.onopen = onOpen;
  ws.onmessage = onMessage;
  ws.onclose = () => setTimeout(connectWs, 2000);
})();
