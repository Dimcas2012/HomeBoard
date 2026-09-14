(() => {
  const ICE = window.HomeBoardWebRTC?.iceConfig?.() || {
    iceServers: window.HOMEBOARD?.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };
  const grid = document.getElementById('camera-grid');
  const toasts = document.getElementById('toasts');
  const drawer = document.getElementById('ctrlDrawer');
  const backdrop = document.getElementById('ctrlBackdrop');
  const peers = new Map();
  const cameraState = new Map();
  const watchTimers = new Map();
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
    setTimeout(() => {
      if (selectedCameraId === cameraId && !cameraState.get(cameraId)) {
        document.getElementById('ctrlStatus').textContent =
          'Немає відповіді камери — перезавантажте /camera/ або Android-додаток';
      }
    }, 4000);
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

    const ms = state.motion_settings || {};
    const sens = drawer.querySelector('input[data-act="motion_sensitivity"]');
    const cd = drawer.querySelector('input[data-act="motion_cooldown"]');
    if (sens && ms.sensitivity != null) sens.value = String(ms.sensitivity);
    if (cd && ms.cooldown_sec != null) cd.value = String(ms.cooldown_sec);
    const sensLabel = document.getElementById('ctrlSensLabel');
    const cdLabel = document.getElementById('ctrlCdLabel');
    if (sensLabel && ms.sensitivity != null) sensLabel.textContent = String(ms.sensitivity);
    if (cdLabel && ms.cooldown_sec != null) cdLabel.textContent = String(ms.cooldown_sec);
    renderCtrlSectors(Array.isArray(ms.sectors) ? ms.sectors : null);
    applyCtrlSchedule(ms.schedule || null, ms);

    document.getElementById('ctrlStatus').textContent = [
      state.streaming ? 'Streaming' : 'Idle',
      state.native ? 'Android app' : 'Browser',
      state.online === false ? 'offline' : 'online',
      ms.sensitivity != null ? `motion ${ms.sensitivity}/10` : null,
      ms.schedule?.enabled
        ? (ms.schedule_active ? 'розклад ✓' : 'поза розкладом')
        : null,
    ].filter(Boolean).join(' · ');

    drawer.querySelectorAll('button[data-act="torch"], input[data-act="torch"]').forEach((n) => {
      n.disabled = state.torch_available === false;
    });
    drawer.querySelectorAll('button[data-act="eco"], input[data-act="eco"]').forEach((n) => {
      n.disabled = state.eco_available === false;
    });
  }

  function currentCtrlSectors() {
    const gridEl = document.getElementById('ctrlSectorGrid');
    if (!gridEl) return Array(12).fill(true);
    return [...gridEl.querySelectorAll('button')].map((b) => b.classList.contains('on'));
  }

  const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

  function fillCtrlHourSelects() {
    const start = drawer.querySelector('select[data-act="motion_start_hour"]');
    const end = drawer.querySelector('select[data-act="motion_end_hour"]');
    if (start && !start.options.length) {
      for (let h = 0; h <= 23; h++) {
        const o = document.createElement('option');
        o.value = String(h);
        o.textContent = `${String(h).padStart(2, '0')}:00`;
        start.appendChild(o);
      }
    }
    if (end && !end.options.length) {
      for (let h = 0; h <= 24; h++) {
        const o = document.createElement('option');
        o.value = String(h);
        o.textContent = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
        end.appendChild(o);
      }
    }
  }

  function currentCtrlDays() {
    const box = document.getElementById('ctrlMotionDays');
    if (!box) return Array(7).fill(true);
    return [...box.querySelectorAll('button')].map((b) => b.classList.contains('on'));
  }

  function sendCtrlSchedule(partial = {}) {
    if (!selectedCameraId) return;
    const enabledInput = drawer.querySelector('input[data-act="motion_schedule_enabled"]');
    const start = drawer.querySelector('select[data-act="motion_start_hour"]');
    const end = drawer.querySelector('select[data-act="motion_end_hour"]');
    sendControl(selectedCameraId, 'motion_schedule', {
      enabled: enabledInput ? enabledInput.checked : false,
      days: currentCtrlDays(),
      start_hour: Number(start?.value || 0),
      end_hour: Number(end?.value || 24),
      ...partial,
    });
  }

  function applyCtrlSchedule(schedule, ms = {}) {
    fillCtrlHourSelects();
    const enabledInput = drawer.querySelector('input[data-act="motion_schedule_enabled"]');
    const start = drawer.querySelector('select[data-act="motion_start_hour"]');
    const end = drawer.querySelector('select[data-act="motion_end_hour"]');
    const hint = document.getElementById('ctrlScheduleHint');
    const sch = schedule || { enabled: false, days: Array(7).fill(true), start_hour: 0, end_hour: 24 };
    if (enabledInput) enabledInput.checked = !!sch.enabled;
    if (start && sch.start_hour != null) start.value = String(sch.start_hour);
    if (end && sch.end_hour != null) end.value = String(sch.end_hour);
    const box = document.getElementById('ctrlMotionDays');
    if (box) {
      const days = Array.isArray(sch.days) ? sch.days.slice(0, 7) : Array(7).fill(true);
      while (days.length < 7) days.push(true);
      box.innerHTML = '';
      days.forEach((on, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = DAY_LABELS[idx];
        btn.classList.toggle('on', !!on);
        btn.disabled = !sch.enabled;
        btn.addEventListener('click', () => {
          if (!selectedCameraId || !enabledInput?.checked) return;
          btn.classList.toggle('on');
          sendCtrlSchedule({ days: currentCtrlDays() });
        });
        box.appendChild(btn);
      });
    }
    if (hint) {
      hint.textContent = sch.enabled
        ? (ms.schedule_summary || 'розклад увімкнено')
        : 'розклад вимкнено — фіксація завжди';
    }
    if (start) start.disabled = !sch.enabled;
    if (end) end.disabled = !sch.enabled;
  }

  function renderCtrlSectors(sectors) {
    const gridEl = document.getElementById('ctrlSectorGrid');
    if (!gridEl) return;
    const list = Array.isArray(sectors) && sectors.length
      ? sectors.slice(0, 12)
      : Array(12).fill(true);
    while (list.length < 12) list.push(true);
    gridEl.innerHTML = '';
    list.forEach((on, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(idx + 1);
      btn.classList.toggle('on', !!on);
      btn.addEventListener('click', () => {
        if (!selectedCameraId) return;
        btn.classList.toggle('on');
        sendControl(selectedCameraId, 'motion_sectors', currentCtrlSectors());
      });
      gridEl.appendChild(btn);
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

  function ensureSectorUi(el) {
    if (!el) return null;
    let gridEl = el.querySelector('.tile-sectors');
    if (!gridEl) {
      gridEl = document.createElement('div');
      gridEl.className = 'tile-sectors';
      gridEl.setAttribute('aria-hidden', 'true');
      el.insertBefore(gridEl, el.querySelector('.tile-controls') || el.querySelector('.tile-meta'));
    }
    if (!gridEl.children.length) {
      for (let i = 0; i < 12; i++) {
        const cell = document.createElement('span');
        cell.dataset.sector = String(i);
        cell.textContent = String(i + 1);
        gridEl.appendChild(cell);
      }
    }
    let label = el.querySelector('.tile-sectors-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'tile-sectors-label';
      label.hidden = true;
      gridEl.after(label);
    }
    return { gridEl, label };
  }

  function showMotionSectors(el, sectors, meta = {}) {
    const ui = ensureSectorUi(el);
    if (!ui) return;
    const hot = new Set((sectors || []).map((n) => Number(n)).filter((n) => n >= 0 && n < 12));
    ui.gridEl.classList.add('show');
    [...ui.gridEl.children].forEach((cell, idx) => {
      cell.classList.toggle('hot', hot.has(idx));
    });
    const nums = [...hot].sort((a, b) => a - b).map((n) => n + 1);
    const scoreBit = meta.score != null ? ` · ${Number(meta.score).toFixed(0)}` : '';
    ui.label.hidden = false;
    ui.label.textContent = nums.length
      ? `Сектори: ${nums.join(', ')}${scoreBit}`
      : `Рух${scoreBit}`;
    clearTimeout(el._motionSectorTimer);
    el._motionSectorTimer = setTimeout(() => {
      ui.gridEl.classList.remove('show');
      [...ui.gridEl.children].forEach((cell) => cell.classList.remove('hot'));
      ui.label.hidden = true;
    }, 6000);
  }

  function ensureTile(cam) {
    let el = tile(cam.id || cam.camera_id);
    if (el) {
      ensureSectorUi(el);
      return el;
    }
    const id = cam.id || cam.camera_id;
    el = document.createElement('div');
    el.className = 'tile';
    el.dataset.cameraId = id;
    el.dataset.source = cam.source_type || 'browser';
    el.dataset.whep = cam.webrtc_play_url || '';
    el.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="placeholder">Офлайн</div>
      <div class="tile-sectors" aria-hidden="true"></div>
      <div class="tile-sectors-label" hidden></div>
      ${controlsHtml(id)}
      <div class="tile-meta">
        <span><span class="dot"></span>${cam.name || 'Camera'}</span>
        <span class="muted cam-state">${cam.source_type || 'browser'}</span>
      </div>`;
    grid.querySelector('.empty')?.remove();
    grid.appendChild(el);
    ensureSectorUi(el);
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

  function scheduleWatch(cameraId, { force = false } = {}) {
    if (watchTimers.has(cameraId)) clearTimeout(watchTimers.get(cameraId));
    watchTimers.set(cameraId, setTimeout(() => {
      watchTimers.delete(cameraId);
      watchBrowserCamera(cameraId, { force });
    }, 400));
  }

  async function watchBrowserCamera(cameraId, { force = false } = {}) {
    const existing = peers.get(cameraId);
    if (!force && existing?.pc && ['connected', 'connecting'].includes(existing.pc.connectionState)) {
      return;
    }
    closePeer(cameraId);

    const el = tile(cameraId);
    if (el) setPlaceholder(el, 'Підключення…', false);

    const session = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      if (!t || t.querySelector('video')?.srcObject) return;
      if (state === 'failed' || state === 'disconnected') {
        setPlaceholder(t, 'Зʼєднання втрачено', false);
        if (state === 'failed') {
          setTimeout(() => scheduleWatch(cameraId, { force: true }), 2000);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      const t = tile(cameraId);
      if (!t || t.querySelector('video')?.srcObject) return;
      const state = pc.iceConnectionState;
      if (state === 'checking') setPlaceholder(t, 'ICE…', false);
      if (state === 'connected' || state === 'completed') setPlaceholder(t, null, true);
      if (state === 'failed') setPlaceholder(t, 'ICE failed — клік для повтору', false);
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
        const ice = pc.iceConnectionState;
        setPlaceholder(
          t,
          ice === 'failed'
            ? 'ICE failed — клік для повтору'
            : `Немає відео (${ice || 'no-offer'}) — клік для повтору`,
          false,
        );
      }
    }, 15000);

    peers.set(cameraId, { pc, watchTimer, session });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watch', camera_id: cameraId, session }));
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
        scheduleWatch(el.dataset.cameraId, { force: true });
        return;
      }
      el.classList.toggle('fullscreen');
    });
  }

  grid.querySelectorAll('.tile').forEach((el) => {
    ensureSectorUi(el);
    bindTile(el);
  });

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
      if (act === 'sectors_all') {
        sendControl(selectedCameraId, 'motion_sectors', Array(12).fill(true));
        renderCtrlSectors(Array(12).fill(true));
      }
      if (act === 'sectors_none') {
        sendControl(selectedCameraId, 'motion_sectors', Array(12).fill(false));
        renderCtrlSectors(Array(12).fill(false));
      }
    }
    if (input && input.type === 'checkbox') {
      sendControl(selectedCameraId, input.dataset.act, input.checked);
    }
    if (select) {
      sendControl(selectedCameraId, 'facing', select.value);
    }
  });

  drawer.addEventListener('input', (ev) => {
    const input = ev.target.closest('input[type="range"][data-act]');
    if (!input || !selectedCameraId) return;
    if (input.dataset.act === 'motion_sensitivity') {
      document.getElementById('ctrlSensLabel').textContent = input.value;
    }
    if (input.dataset.act === 'motion_cooldown') {
      document.getElementById('ctrlCdLabel').textContent = input.value;
    }
  });

  drawer.addEventListener('change', (ev) => {
    const input = ev.target.closest('input[data-act], select[data-act]');
    if (!input || !selectedCameraId) return;
    if (input.dataset.act === 'motion_sensitivity') {
      sendControl(selectedCameraId, 'motion_sensitivity', Number(input.value));
    }
    if (input.dataset.act === 'motion_cooldown') {
      sendControl(selectedCameraId, 'motion_cooldown', Number(input.value));
    }
    if (input.dataset.act === 'motion_schedule_enabled') {
      sendCtrlSchedule({ enabled: input.checked });
      applyCtrlSchedule({
        enabled: input.checked,
        days: currentCtrlDays(),
        start_hour: Number(drawer.querySelector('select[data-act="motion_start_hour"]')?.value || 0),
        end_hour: Number(drawer.querySelector('select[data-act="motion_end_hour"]')?.value || 24),
      });
    }
    if (input.dataset.act === 'motion_start_hour' || input.dataset.act === 'motion_end_hour') {
      sendCtrlSchedule();
    }
  });

  fillCtrlHourSelects();
  applyCtrlSchedule({ enabled: false, days: Array(7).fill(true), start_hour: 0, end_hour: 24 });
  renderCtrlSectors(Array(12).fill(true));

  document.getElementById('ctrlClose')?.addEventListener('click', closeDrawer);
  backdrop?.addEventListener('click', closeDrawer);

  function connectWs() {
    ws = new WebSocket(wsUrl());
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = () => setTimeout(connectWs, 2000);
  }

  function onOpen() {
    // camera_list arrives right after connect and drives watches — avoid double watch race.
    grid.querySelectorAll('.tile').forEach((el) => {
      if (el.dataset.source === 'rtsp') playWhep(el);
    });
  }

  async function onMessage(evt) {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'camera_list') {
      for (const cam of msg.cameras || []) {
        const el = ensureTile(cam);
        el.querySelector('.dot').classList.toggle('on', !!cam.is_online);
        if (cam.source_type === 'rtsp') playWhep(el);
        else if (cam.is_online) scheduleWatch(cam.id, { force: true });
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
      scheduleWatch(msg.camera_id, { force: true });
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

    if (msg.type === 'camera_unreachable') {
      const el = tile(msg.camera_id);
      if (el) {
        el.querySelector('.dot')?.classList.remove('on');
        setPlaceholder(el, msg.reason || 'Камера не в мережі', false);
        const v = el.querySelector('video');
        if (v) v.srcObject = null;
      }
      closePeer(msg.camera_id);
      return;
    }

    if (msg.type === 'offer_error' && msg.from === 'camera') {
      const el = tile(msg.camera_id);
      if (el) setPlaceholder(el, msg.error || 'Помилка камери', false);
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
      const sectors = Array.isArray(msg.sectors) ? msg.sectors : [];
      const nums = sectors.map((n) => Number(n) + 1).filter((n) => n >= 1);
      toast(
        nums.length
          ? `Рух: ${msg.camera_name || msg.camera_id} · сектори ${nums.join(', ')}`
          : `Рух: ${msg.camera_name || msg.camera_id}`,
      );
      const el = tile(msg.camera_id);
      if (el) {
        el.classList.add('motion');
        showMotionSectors(el, sectors, { score: msg.score, threshold: msg.threshold });
        clearTimeout(el._motionOutlineTimer);
        el._motionOutlineTimer = setTimeout(() => el.classList.remove('motion'), 6000);
      }
    }
  }

  connectWs();
})();
