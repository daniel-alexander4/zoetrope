// audio.js — bidirectional voice over WebRTC, with signaling routed over
// the session WS via four verbs: audio-offer, audio-answer, audio-ice,
// audio-bye. SoT for the browser-side state machine and the
// RTCPeerConnection lifecycle; manage.js and app.js own only their own UI.
//
// Either side can initiate; the receiver always sees Accept / Decline.
// Media flows direct browser↔browser over DTLS-SRTP (UDP); the Go
// process never sees raw audio. No STUN/TURN per CLAUDE.md "no
// telemetry, no phone-home" — ICE relies on host + peer-reflexive
// candidates over the public addresses the WS already requires.
//
// State machine (state.state):
//   idle               nothing in flight
//   outgoing-ringing   sent audio-offer, waiting for audio-answer
//   incoming-ringing   received audio-offer, awaiting local Accept/Decline
//   connecting         offer+answer exchanged, ICE handshake in progress
//   connected          peer connection up, audio flowing
//
// Mic-mute is local-only (no signaling) — muted user still hears peer.
// Speaker volume + speaker-mute are local. Hang-up sends audio-bye.

(() => {
  'use strict';

  const state = {
    state: 'idle',
    peerFP: null,          // null on the client side (manager is the only peer)
    peerLabel: null,
    pendingOffer: null,    // { sdp, fromFP, fromLabel } while incoming-ringing
    pc: null,
    localStream: null,
    audioEl: null,
    micMuted: false,
    speakerVolume: 1.0,
    speakerMuted: false,
    sendVerb: null,        // (verb, peerFP) → void, set in init
    onStateChange: () => {},
  };

  function init(opts) {
    state.sendVerb = (opts && opts.sendVerb) || (() => {});
    state.onStateChange = (opts && opts.onStateChange) || (() => {});
    if (!state.audioEl) {
      // Hidden audio sink for the remote stream. Autoplay is allowed for
      // media we attached after a user gesture (Accept/Call click).
      state.audioEl = document.createElement('audio');
      state.audioEl.autoplay = true;
      state.audioEl.style.display = 'none';
      document.body.appendChild(state.audioEl);
    }
    applyAudioOutput();
  }

  function setState(newState, peerFP, peerLabel) {
    state.state = newState;
    if (peerFP !== undefined) state.peerFP = peerFP;
    if (peerLabel !== undefined) state.peerLabel = peerLabel;
    state.onStateChange(snapshot());
  }

  function snapshot() {
    return {
      state: state.state,
      peerFP: state.peerFP,
      peerLabel: state.peerLabel,
      micMuted: state.micMuted,
      speakerVolume: state.speakerVolume,
      speakerMuted: state.speakerMuted,
    };
  }

  function applyAudioOutput() {
    if (!state.audioEl) return;
    state.audioEl.volume = state.speakerMuted ? 0 : state.speakerVolume;
  }

  async function startCall(peerFP, peerLabel) {
    if (state.state !== 'idle') {
      throw new Error('already in a call (state=' + state.state + ')');
    }
    setState('outgoing-ringing', peerFP || null, peerLabel || null);
    try {
      ensurePeerConnection();
      await captureMic();
      const offer = await state.pc.createOffer({ offerToReceiveAudio: true });
      await state.pc.setLocalDescription(offer);
      state.sendVerb({ type: 'audio-offer', sdp: state.pc.localDescription.sdp }, state.peerFP);
    } catch (err) {
      teardown('start-error');
      throw err;
    }
  }

  // handleSignal is called by the UI layers when an audio-* verb arrives
  // over the wire. fromFP / fromLabel come from the SSE event payload
  // on the manager side (which session sent it); both are null on the
  // client side because there's only one peer.
  async function handleSignal(verb, fromFP, fromLabel) {
    if (!verb || !verb.type) return;
    switch (verb.type) {
      case 'audio-offer': {
        if (state.state !== 'idle') {
          // Busy — politely decline this offer rather than glare.
          state.sendVerb({ type: 'audio-bye', reason: 'busy' }, fromFP || state.peerFP);
          return;
        }
        state.pendingOffer = { sdp: verb.sdp, fromFP: fromFP || null, fromLabel: fromLabel || null };
        setState('incoming-ringing', fromFP || null, fromLabel || null);
        break;
      }
      case 'audio-answer': {
        if (state.state !== 'outgoing-ringing' || !state.pc) return;
        try {
          await state.pc.setRemoteDescription({ type: 'answer', sdp: verb.sdp });
          setState('connecting');
        } catch (err) {
          console.error('audio: setRemoteDescription(answer):', err);
          teardown('answer-error');
        }
        break;
      }
      case 'audio-ice': {
        if (!state.pc) return;
        if (!verb.candidate) {
          // End-of-candidates marker. addIceCandidate(null) signals this
          // to the peer connection.
          try { await state.pc.addIceCandidate(null); } catch (e) { /* ignore */ }
          return;
        }
        try {
          await state.pc.addIceCandidate({
            candidate: verb.candidate,
            sdpMid: verb.sdpMid || '',
            sdpMLineIndex: verb.sdpMLineIndex ?? 0,
          });
        } catch (err) {
          console.warn('audio: addIceCandidate:', err);
        }
        break;
      }
      case 'audio-bye': {
        teardown(verb.reason || 'remote-bye');
        break;
      }
    }
  }

  async function acceptCall() {
    if (state.state !== 'incoming-ringing' || !state.pendingOffer) return;
    const { sdp, fromFP, fromLabel } = state.pendingOffer;
    state.pendingOffer = null;
    try {
      ensurePeerConnection();
      await captureMic();
      await state.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      state.sendVerb({ type: 'audio-answer', sdp: state.pc.localDescription.sdp }, fromFP);
      setState('connecting', fromFP, fromLabel);
    } catch (err) {
      console.error('audio: accept:', err);
      state.sendVerb({ type: 'audio-bye', reason: 'accept-error' }, fromFP);
      teardown('accept-error');
    }
  }

  function declineCall() {
    if (state.state !== 'incoming-ringing') return;
    state.sendVerb({ type: 'audio-bye', reason: 'declined' }, state.peerFP);
    teardown('declined');
  }

  function hangup() {
    if (state.state === 'idle') return;
    state.sendVerb({ type: 'audio-bye', reason: 'hangup' }, state.peerFP);
    teardown('hangup');
  }

  function teardown(_reason) {
    if (state.pc) {
      try { state.pc.close(); } catch (e) { /* ignore */ }
      state.pc = null;
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
    }
    if (state.audioEl) state.audioEl.srcObject = null;
    state.pendingOffer = null;
    setState('idle', null, null);
  }

  function ensurePeerConnection() {
    if (state.pc) return;
    const pc = new RTCPeerConnection({
      // No STUN/TURN per CLAUDE.md. ICE works via host candidates plus
      // peer-reflexive ones discovered when binding requests arrive — the
      // manager's public address is in the session URL the practitioner
      // shared, so at least one side is reachable. Documented in README.
      iceServers: [],
    });
    state.pc = pc;

    pc.ontrack = (e) => {
      // Bind the first inbound stream to the audio element. After the
      // initial bind subsequent tracks (none expected for audio-only) just
      // get added to the existing stream.
      if (!state.audioEl.srcObject && e.streams[0]) {
        state.audioEl.srcObject = e.streams[0];
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        state.sendVerb({
          type: 'audio-ice',
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        }, state.peerFP);
      } else {
        // null marks end-of-candidates. We pass it through too so the peer
        // can stop expecting more.
        state.sendVerb({ type: 'audio-ice', candidate: '' }, state.peerFP);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if ((s === 'connected' || s === 'completed') && state.state === 'connecting') {
        setState('connected');
      } else if (s === 'failed') {
        console.warn('audio: ICE failed');
        teardown('ice-failed');
      } else if (s === 'disconnected') {
        // Brief disconnection may recover; only tear down if it stays
        // down for 5s.
        setTimeout(() => {
          if (state.pc && state.pc.iceConnectionState === 'disconnected') {
            teardown('ice-disconnected');
          }
        }, 5000);
      }
    };
  }

  async function captureMic() {
    if (state.localStream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    state.localStream = stream;
    stream.getAudioTracks().forEach(t => {
      t.enabled = !state.micMuted;
      state.pc.addTrack(t, stream);
    });
  }

  function setMicMuted(b) {
    state.micMuted = !!b;
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted; });
    }
    state.onStateChange(snapshot());
  }

  function setSpeakerVolume(v) {
    state.speakerVolume = Math.max(0, Math.min(1, +v || 0));
    applyAudioOutput();
    state.onStateChange(snapshot());
  }

  function setSpeakerMuted(b) {
    state.speakerMuted = !!b;
    applyAudioOutput();
    state.onStateChange(snapshot());
  }

  function getState() { return snapshot(); }

  // getCallStreams exposes the active local + remote MediaStreams so the
  // capture module can record both sides of the call. Returns nulls when
  // no call is active. Both fields are live MediaStream objects — the
  // caller should not retain them across hangups.
  function getCallStreams() {
    return {
      local: state.localStream,
      remote: state.audioEl && state.audioEl.srcObject,
    };
  }

  window.zoetropeAudio = {
    init, startCall, handleSignal, acceptCall, declineCall, hangup,
    setMicMuted, setSpeakerVolume, setSpeakerMuted, getState,
    getCallStreams,
  };
})();
