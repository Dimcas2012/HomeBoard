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

  window.HomeBoardWebRTC = {
    iceConfig,
    waitIceGathering,
    sdpInit,
  };
})();
