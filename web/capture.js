// capture.js — small primitive used by /manage and / to record the
// active voice call. Mixes the local mic + remote stream from the
// existing WebRTC peer connection into a single audio track via the
// Web Audio API, then runs MediaRecorder over the mixed stream.
//
// The recorder lives across both sides of the call:
//   - On /manage, capture is host-initiated and requires client consent
//     (manage.js owns the protocol flow); the resulting blob is POSTed
//     to /api/clients/<cid>/sessions/<sid>/capture for persistence.
//   - On /, capture is client-side, local-only — no protocol traffic,
//     no server upload, the blob downloads via a browser anchor click.
//
// Either way, this module just hands back a controller and lets the
// caller decide what to do with the resulting Blob.

(() => {
  'use strict';

  // start() opens an AudioContext, fans the call's local + remote
  // streams into a MediaStreamDestination, and starts a MediaRecorder
  // over the destination's mixed track. Returns a controller with
  // stop()→Promise<Blob>. Throws if no call is active.
  function start() {
    const audio = window.zoetropeAudio;
    if (!audio) throw new Error('audio module not loaded');
    const streams = audio.getCallStreams();
    if (!streams || (!streams.local && !streams.remote)) {
      throw new Error('no active call to record');
    }
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    if (streams.local && streams.local.getAudioTracks().length) {
      ctx.createMediaStreamSource(streams.local).connect(dest);
    }
    if (streams.remote && streams.remote.getAudioTracks().length) {
      ctx.createMediaStreamSource(streams.remote).connect(dest);
    }

    const chunks = [];
    const recorder = new MediaRecorder(dest.stream);
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const blobPromise = new Promise(resolve => {
      recorder.onstop = () => {
        ctx.close().catch(() => {});
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
    });
    recorder.start();
    return {
      stop() {
        if (recorder.state !== 'inactive') recorder.stop();
        return blobPromise;
      },
      get state() { return recorder.state; },
    };
  }

  // captureFilename returns "capture-YYYY-MM-DDTHH-MM-SS.webm" in UTC.
  // Used by both sides so saved + downloaded files share a naming style.
  function captureFilename() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return 'capture-'
      + d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
      + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds())
      + '.webm';
  }

  // downloadBlob triggers a browser save dialog for the given blob.
  // Used by the client-side local capture path.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.zoetropeCapture = { start, captureFilename, downloadBlob };
})();
