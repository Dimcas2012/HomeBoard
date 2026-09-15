/**
 * Shared WebRTC helpers for HomeBoard camera ↔ viewer.
 */
(() => {
  function defaultIceServers() {
    const extra = window.HOMEBOARD?.iceServers;
    if (Array.isArray(extra) && extra.length) return extra;
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];
  }

  function iceConfig() {
    return {
      iceServers: defaultIceServers(),
      iceCandidatePoolSize: 4,
    };
  }

  function waitIceGathering(pc, timeoutMs = 2500) {
    if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, timeoutMs);
    });
  }

  function sdpInit(desc) {
    if (!desc) return null;
    if (typeof desc === 'string') return { type: 'offer', sdp: desc };
    return { type: desc.type, sdp: desc.sdp };
  }

  function prepareVideoEl(video) {
    if (!video) return video;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');
    video.playsInline = true;
    video.autoplay = true;
    try { video.disablePictureInPicture = true; } catch (_) { /* ignore */ }
    return video;
  }

  function streamFromTrackEvent(ev, prev) {
    const out = new MediaStream();
    const seen = new Set();
    const add = (track) => {
      if (!track || seen.has(track.id)) return;
      seen.add(track.id);
      out.addTrack(track);
    };
    if (prev instanceof MediaStream) prev.getTracks().forEach(add);
    if (ev?.streams) ev.streams.forEach((s) => s.getTracks().forEach(add));
    add(ev?.track);
    return out;
  }

  function preferH264(pc) {
    try {
      const caps = RTCRtpSender.getCapabilities?.('video');
      if (!caps?.codecs?.length || !pc?.getTransceivers) return;
      const preferred = [];
      const rest = [];
      for (const c of caps.codecs) {
        if ((c.mimeType || '').toLowerCase() === 'video/h264') preferred.push(c);
        else rest.push(c);
      }
      if (!preferred.length) return;
      const ordered = [...preferred, ...rest];
      pc.getTransceivers().forEach((t) => {
        const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
        if (kind && kind !== 'video') return;
        try { t.setCodecPreferences(ordered); } catch (_) { /* ignore */ }
      });
    } catch (_) { /* ignore */ }
  }

  window.HomeBoardWebRTC = {
    iceConfig,
    waitIceGathering,
    sdpInit,
    prepareVideoEl,
    streamFromTrackEvent,
    preferH264,
  };
})();
