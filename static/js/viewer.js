(() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const grid = document.getElementById('camera-grid');
  const toasts = document.getElementById('toasts');
  const peers = new Map(); // cameraId -> RTCPeerConnection
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

  function tile(cameraId) {
    return grid.querySelector(`.tile[data-camera-id="${cameraId}"]`);
  }

  function ensureTile(cam) {
    let el = tile(cam.id);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tile';
    el.dataset.cameraId = cam.id;
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
      el.querySelector('.placeholder').hidden = true;
      el.querySelector('.dot').classList.add('on');
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!res.ok) {
      el.querySelector('.placeholder').textContent = 'MediaMTX offline';
      return;
    }
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    peers.set(el.dataset.cameraId, pc);
  }

  async function watchBrowserCamera(cameraId) {
    if (peers.has(cameraId)) return;
    const pc = new RTCPeerConnection(ICE);
    peers.set(cameraId, pc);
    pc.ontrack = (ev) => {
      const el = tile(cameraId);
      if (!el) return;
      el.querySelector('video').srcObject = ev.streams[0];
      el.querySelector('.placeholder').hidden = true;
      el.querySelector('.dot').classList.add('on');
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        ws.send(JSON.stringify({
          type: 'ice',
          camera_id: cameraId,
          candidate: ev.candidate,
        }));
      }
    };
    ws.send(JSON.stringify({ type: 'watch', camera_id: cameraId }));
  }

  function bindTile(el) {
    el.addEventListener('click', () => {
      el.classList.toggle('fullscreen');
    });
  }

  grid.querySelectorAll('.tile').forEach(bindTile);

  const ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    grid.querySelectorAll('.tile').forEach((el) => {
      if (el.dataset.source === 'rtsp') playWhep(el);
      else if (el.dataset.source === 'browser') {
        // wait for camera_online or request watch if already online (dot.on)
        if (el.querySelector('.dot.on')) watchBrowserCamera(el.dataset.cameraId);
      }
    });
  };

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'camera_list') {
      for (const cam of msg.cameras || []) {
        const el = ensureTile(cam);
        el.querySelector('.dot').classList.toggle('on', !!cam.is_online);
        if (cam.source_type === 'rtsp') playWhep(el);
        else if (cam.is_online) watchBrowserCamera(cam.id);
      }
      return;
    }

    if (msg.type === 'camera_online') {
      const el = ensureTile(msg);
      el.querySelector('.dot').classList.add('on');
      el.querySelector('.placeholder').textContent = 'Підключення…';
      watchBrowserCamera(msg.camera_id);
      return;
    }

    if (msg.type === 'camera_offline') {
      const el = tile(msg.camera_id);
      if (el) {
        el.querySelector('.dot').classList.remove('on');
        el.querySelector('.placeholder').hidden = false;
        el.querySelector('.placeholder').textContent = 'Офлайн';
        const v = el.querySelector('video');
        v.srcObject = null;
      }
      const pc = peers.get(msg.camera_id);
      if (pc) { pc.close(); peers.delete(msg.camera_id); }
      return;
    }

    if (msg.type === 'offer' && msg.from === 'camera') {
      const pc = peers.get(msg.camera_id);
      if (!pc) return;
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({
        type: 'answer',
        camera_id: msg.camera_id,
        sdp: pc.localDescription,
        viewer_channel: msg.viewer_channel,
      }));
      return;
    }

    if (msg.type === 'ice' && msg.from === 'camera') {
      const pc = peers.get(msg.camera_id);
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (_) {}
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
  };

  // For already-online browser cams rendered by Django
  setTimeout(() => {
    grid.querySelectorAll('.tile[data-source="browser"] .dot.on').forEach((dot) => {
      const id = dot.closest('.tile').dataset.cameraId;
      if (ws.readyState === WebSocket.OPEN) watchBrowserCamera(id);
    });
    grid.querySelectorAll('.tile[data-source="rtsp"]').forEach(playWhep);
  }, 500);
})();
