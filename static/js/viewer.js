(() => {
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const grid = document.getElementById('camera-grid');
  const toasts = document.getElementById('toasts');
  const drawer = document.getElementById('ctrlDrawer');
  const backdrop = document.getElementById('ctrlBackdrop');
  const peers = new Map();
  const cameraState = new Map();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let selectedCameraId = null;
  let ws;

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

  function sendControl(cameraId, action, value) {
    if (!cameraId || !ws || ws.readyState !== WebSocket.OPEN) {
      toast('Немає звʼязку з сервером');
      return;
    }
    ws.send(JSON.stringify({
      type: 'control',
      camera_id: cameraId,
      action,
      value: value === undefined ? null : value,
    }));
  }

  function openDrawer(cameraId) {
    selectedCameraId = cameraId;
    const el = tile(cameraId);
    const name = el?.querySelector('.tile-meta span')?.textContent?.replace(/^./, '').trim()
      || cameraId;
    document.getElementById('ctrlTitle').textContent = name;
    document.getElementById('ctrlSubtitle').textContent = `ID: ${cameraId.slice(0, 8)}…`;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    backdrop.classList.add('show');
    applyStateToDrawer(cameraState.get(cameraId));
    sendControl(cameraId, 'get_state');
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
    backdrop.classList.remove('show');
  }

  function applyStateToDrawer(state) {
    if (!state) {
      document.getElementById('ctrlStatus').textContent = 'Очікування стану камери…';
      return;
    }
    const setCheck = (act, val) => {
      const input = drawer.querySelector(`input[data-act="${act}"]`);
      if (input) input.checked = !!val;
    };
    setCheck('dual', state.dual);
    setCheck('motion', state.motion);
    setCheck('record_motion', state.record_motion);
    setCheck('torch', state.torch);
    setCheck('eco', state.eco);
    const facing = drawer.querySelector('select[data-act="facing"]');
    if (facing && state.facing) facing.value = state.facing;
    document.getElementById('ctrlStatus').textContent = [
      state.streaming ? 'Streaming' : 'Idle',
      state.native ? 'Android app' : 'Browser',
      state.online === false ? 'offline' : 'online',
    ].filter(Boolean).join(' · ');

    drawer.querySelectorAll('button[data-act="torch"], input[data-act="torch"]').forEach((n) => {
      n.disabled = state.torch_available === false;
    });
    drawer.querySelectorAll('button[data-act="eco"], input[data-act="eco"]').forEach((n) => {
      n.disabled = state.eco_available === false;
    });
  }

  function updateTileState(cameraId, state) {
    cameraState.set(cameraId, state);
    const el = tile(cameraId);
    if (!el) return;
    const label = el.querySelector('.cam-state');
    if (label) {
      const bits = [];
      if (state.streaming) bits.push('live');
      if (state.torch) bits.push('🔦');
      if (state.eco) bits.push('eco');
      if (state.dual) bits.push('dual');
      label.textContent = bits.join(' · ') || el.dataset.source || 'browser';
    }
    el.querySelectorAll('.tile-controls button[data-act="torch"]').forEach((b) => {
      b.classList.toggle('on', !!state.torch);
      b.disabled = state.torch_available === false;
    });
    el.querySelectorAll('.tile-controls button[data-act="eco"]').forEach((b) => {
      b.classList.toggle('on', !!state.eco);
    });
    if (selectedCameraId === cameraId) applyStateToDrawer(state);
  }

  function controlsHtml(id) {
    return `<div class="tile-controls" data-controls-for="${id}">
      <button type="button" data-act="panel" title="Налаштування">⚙</button>
      <button type="button" data-act="flip" title="Перемкнути камеру">⇄</button>
      <button type="button" data-act="torch" title="Ліхтарик">🔦</button>
      <button type="button" data-act="eco" title="Економ-режим">☾</button>
      <button type="button" data-act="fs" title="На весь екран">⛶</button>
    </div>`;
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
      ${controlsHtml(id)}
      <div class="tile-meta">
        <span><span class="dot"></span>${cam.name || 'Camera'}</span>
        <span class="muted cam-state">${cam.source_type || 'browser'}</span>
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
        setPlaceholder(t, 'Немає відео — ⚙ або клік по плитці', false);
      }
    }, 12000);

    peers.set(cameraId, { pc, watchTimer });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watch', camera_id: cameraId }));
      sendControl(cameraId, 'get_state');
    }
  }

  function handleTileAction(cameraId, act, el) {
    if (act === 'panel') {
      openDrawer(cameraId);
      return;
    }
    if (act === 'fs') {
      el.classList.toggle('fullscreen');
      return;
    }
    if (el.dataset.source !== 'browser') {
      toast('Керування доступне для browser-камер');
      return;
    }
    if (act === 'flip') sendControl(cameraId, 'flip');
    if (act === 'torch') {
      const cur = cameraState.get(cameraId);
      sendControl(cameraId, 'torch', !(cur && cur.torch));
    }
    if (act === 'eco') {
      const cur = cameraState.get(cameraId);
      sendControl(cameraId, 'eco', !(cur && cur.eco));
    }
  }

  function bindTile(el) {
    el.querySelector('.tile-controls')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      handleTileAction(el.dataset.cameraId, btn.dataset.act, el);
    });

    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.tile-controls')) return;
      const video = el.querySelector('video');
      if (el.dataset.source === 'browser' && !video?.srcObject) {
        watchBrowserCamera(el.dataset.cameraId, { force: true });
        return;
      }
      el.classList.toggle('fullscreen');
    });
  }

  grid.querySelectorAll('.tile').forEach(bindTile);

  drawer.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    const input = ev.target.closest('input[data-act]');
    const select = ev.target.closest('select[data-act]');
    if (!selectedCameraId) return;

    if (btn) {
      const act = btn.dataset.act;
      if (act === 'start') sendControl(selectedCameraId, 'start');
      if (act === 'stop') sendControl(selectedCameraId, 'stop');
      if (act === 'flip') sendControl(selectedCameraId, 'flip');
      if (act === 'refresh_state') sendControl(selectedCameraId, 'get_state');
    }
    if (input && input.type === 'checkbox') {
      sendControl(selectedCameraId, input.dataset.act, input.checked);
    }
    if (select) {
      sendControl(selectedCameraId, 'facing', select.value);
    }
  });

  document.getElementById('ctrlClose')?.addEventListener('click', closeDrawer);
  backdrop?.addEventListener('click', closeDrawer);

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

    if (msg.type === 'camera_state' || msg.type === 'control_ack') {
      if (msg.state) updateTileState(msg.camera_id, msg.state);
      if (msg.type === 'control_ack' && msg.ok === false) {
        toast(msg.error || 'Команда не виконана');
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

  connectWs();
})();
