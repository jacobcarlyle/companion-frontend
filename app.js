// app.js — Elder Companion voice client (v2.0, GA Realtime API)
// ───  SET THESE TWO VALUES FOR YOUR DEPLOYMENT ───────────────────────────
const API_BASE       = 'https://api.carlyle.me';
const SESSION_SECRET = '99656fd155883d95b87a6a9984eba1d8ad643b8c83eb2f9756ecc55f281d174c';
const INGEST_SECRET  = '5c84d4f156bf117a4828a542c8164fe5de387d050e4e76df4544240a27ab34ee';
// Note: The frontend-baked secrets gate /session and /ingest to reduce
// casual abuse. They are not a hard security boundary — real protection is:
// CORS locked to this origin + person allowlist server-side + 30-min cap.
// ─────────────────────────────────────────────────────────────────────────

const MAX_SESSION_MS = 30 * 60 * 1000;

const params = new URLSearchParams(location.search);
const VALID_PERSONS = ['mum','dad','mil','jacob','leanne','kye','sam','keira'];
const person = VALID_PERSONS.includes(params.get('person')) ? params.get('person') : null;

const el = {
  card      : document.getElementById('card'),
  btn       : document.getElementById('talkBtn'),
  btnLabel  : document.getElementById('btnLabel'),
  greet     : document.getElementById('greet'),
  status    : document.getElementById('status'),
  transcript: document.getElementById('transcript'),
  endBtn    : document.getElementById('endBtn')
};

// ── PIN gate ──────────────────────────────────────────────────────────────────
const pinState = { buf: '', verified: false, token: null };

function renderPin() {
  const d = document.getElementById('pinDisplay');
  const dots = pinState.buf.padEnd(4, '-').split('').map(c => c === '-' ? '-' : '•').join(' ');
  d.textContent = dots;
}

function setPinHint(msg, isErr) {
  const h = document.getElementById('pinHint');
  h.textContent = msg;
  h.classList.toggle('err', !!isErr);
}

async function submitPin() {
  setPinHint('Checking…', false);
  try {
    const r = await fetch(`${API_BASE}/verify-pin`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ person, pin: pinState.buf })
    });
    if (r.status === 429) {
      setPinHint('Too many tries. Please try again later.', true);
      return;
    }
    if (!r.ok) {
      setPinHint('That doesn\'t look right — try again', true);
      pinState.buf = '';
      renderPin();
      return;
    }
    const data = await r.json();
    pinState.verified = true;
    pinState.token    = data.token;
    document.getElementById('pinGate').style.display     = 'none';
    await prepareChatAfterPin();
  } catch {
    setPinHint('Connection problem — try again in a moment', true);
  }
}

async function fetchVoiceConfig() {
  const r = await fetch(`${API_BASE}/elder-voice-config?personId=${encodeURIComponent(person)}`, {
    cache: 'no-store'
  });
  if (!r.ok) throw new Error(`voice-config-${r.status}`);
  return r.json();
}

async function prepareChatAfterPin() {
  document.getElementById('chatControls').style.display = 'block';
  el.status.textContent = 'Getting things ready...';
  try {
    currentVoiceConfig = await fetchVoiceConfig();
  } catch (err) {
    console.warn('[companion] voice config unavailable, using Realtime:', err);
    currentVoiceConfig = { cascade_enabled: false };
  }

  if (currentVoiceConfig.cascade_enabled) {
    await setupCascadeControls(currentVoiceConfig);
  } else {
    setupRealtimeControls(currentVoiceConfig);
  }
}

function setupRealtimeControls(cfg) {
  activeMode = 'realtime';
  const name = cfg.person_name || ({ mum: 'Bev', dad: 'Tim', mil: 'Jan', jacob: 'Jacob', leanne: 'Leanne', kye: 'Kye', sam: 'Sam', keira: 'Keira' }[person] || 'there');
  el.greet.textContent = `Welcome back, ${name}. Tap when you're ready`;
  el.btn.className = '';
  el.btn.removeAttribute('data-state');
  el.btn.classList.remove('disabled', 'listening', 'thinking');
  el.btnLabel.textContent = 'Tap to Chat';
  el.status.textContent = 'Ready when you are';
  el.transcript.style.display = 'none';
  el.endBtn.style.display = 'none';
  el.btn.onclick = startSession;
}

async function setupCascadeControls(cfg) {
  activeMode = 'cascade';
  sessionEnded = false;
  sessionStartTime = null;
  transcriptItems.clear();
  cascadeAssistantItemId = null;

  const name = cfg.person_name || 'there';
  el.greet.textContent = `Hello, ${name}`;
  el.transcript.innerHTML = '';
  el.transcript.style.display = 'block';
  el.endBtn.style.display = 'block';
  el.endBtn.disabled = false;
  el.endBtn.onclick = endSession;
  el.btn.className = '';
  el.btn.dataset.state = 'idle';
  el.btnLabel.textContent = 'Tap to talk';
  el.status.textContent = 'Tap to talk to me';
  el.btn.classList.add('disabled');

  cascadeClient = new CascadeVoiceClient({ personId: person, baseUrl: API_BASE });
  try {
    await cascadeClient.init();
  } catch (err) {
    console.error('[companion] cascade init failed:', err);
    el.status.textContent = 'Could not start the microphone. Please try again.';
    el.btn.classList.remove('disabled');
    el.btnLabel.textContent = 'Try Again';
    el.btn.onclick = () => setupCascadeControls(cfg);
    return;
  }

  const labels = {
    idle: ['Tap to talk', 'Tap to talk to me'],
    listening: ['Tap when done', "I'm listening"],
    thinking: ['...', 'Just a moment'],
    speaking: ['Speaking', `${name} is speaking`],
  };

  cascadeClient.addEventListener('state', e => {
    const state = e.detail;
    el.btn.dataset.state = state;
    const [buttonText, statusText] = labels[state] || labels.idle;
    el.btnLabel.textContent = buttonText;
    el.status.textContent = statusText;
    el.btn.classList.toggle('disabled', state === 'thinking' || state === 'speaking');
  });

  cascadeClient.addEventListener('transcript', e => {
    if (!sessionStartTime) sessionStartTime = Date.now();
    const text = (e.detail || '').trim();
    if (!text) return;
    transcriptItems.set(`cascade-user-${Date.now()}`, {
      role: 'user',
      text,
      ts: Date.now(),
      seq: seqCounter++,
    });
    cascadeAssistantItemId = `cascade-assistant-${Date.now()}`;
    transcriptItems.set(cascadeAssistantItemId, {
      role: 'assistant',
      text: '',
      ts: Date.now(),
      seq: seqCounter++,
    });
    render();
  });

  cascadeClient.addEventListener('token', e => {
    if (!cascadeAssistantItemId) {
      cascadeAssistantItemId = `cascade-assistant-${Date.now()}`;
      transcriptItems.set(cascadeAssistantItemId, {
        role: 'assistant',
        text: '',
        ts: Date.now(),
        seq: seqCounter++,
      });
    }
    const cur = transcriptItems.get(cascadeAssistantItemId);
    cur.text += e.detail || '';
    cur.ts = Date.now();
    transcriptItems.set(cascadeAssistantItemId, cur);
    render();
  });

  cascadeClient.addEventListener('done', () => {
    cascadeAssistantItemId = null;
    render();
  });

  cascadeClient.addEventListener('error', e => {
    console.error('[companion] cascade error:', e.detail);
    el.status.textContent = "Sorry, I couldn't hear that. Try again?";
  });

  el.btn.classList.remove('disabled');
  el.btn.onclick = () => {
    if (!sessionStartTime) sessionStartTime = Date.now();
    if (cascadeClient.state === 'idle') cascadeClient.startTurn();
    else if (cascadeClient.state === 'listening') cascadeClient.endTurn();
  };
}

// Wire up PIN pad
document.querySelectorAll('.pad[data-d]').forEach(b => {
  b.onclick = () => {
    if (pinState.buf.length >= 4) return;
    pinState.buf += b.dataset.d;
    renderPin();
    if (pinState.buf.length === 4) submitPin();
  };
});
document.getElementById('pinClear').onclick = () => {
  pinState.buf = '';
  renderPin();
  setPinHint('Enter 4 numbers', false);
};
document.getElementById('pinBack').onclick = () => {
  pinState.buf = pinState.buf.slice(0, -1);
  renderPin();
};
renderPin();
// ─────────────────────────────────────────────────────────────────────────────

let pc, dc, localStream, audioEl;
let sessionStartTime = null;
let maxSessionTimer  = null;
let sessionEnded     = false;
let shadowSessionId  = null;
let stopShadowTap    = null;
let activeMode       = 'realtime';
let cascadeClient    = null;
let currentVoiceConfig = null;
let cascadeAssistantItemId = null;

class CascadeVoiceClient extends EventTarget {
  // VERSION: A10-diagnostic
  constructor({ personId, baseUrl }) {
    super();
    console.log('[cascade] app.js version: A10-diagnostic, compiled', new Date().toISOString());
    this.personId = personId;
    this.baseUrl = baseUrl;
    this.state = 'idle';
    this.outQueueTime = 0;
    this.doneReceived = false;
  }

  _setState(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }

  async init() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
    });
    this.ctx = new AudioContextCtor({ sampleRate: 48000 });
    await this.ctx.audioWorklet.addModule('/pcm-resampler-worklet.js');
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, 'pcm-resampler');
    // Run the output AudioContext at the same rate as the PCM stream (16 kHz)
    // so Web Audio does NOT resample. Resampling each AudioBufferSourceNode
    // independently introduces phase/amplitude discontinuities at chunk
    // boundaries that are audible as clicks (~1–2s cadence on Cartesia).
    // Fall back to native rate if the browser rejects 16 kHz; in that case
    // boundary clicks may return until we replace the per-chunk scheduling
    // with an AudioWorklet-based player.
    try {
      this.outCtx = new AudioContextCtor({ sampleRate: 16000 });
    } catch (err) {
      console.warn('[cascade] 16 kHz AudioContext rejected; falling back to native rate (may cause boundary clicks):', err);
      this.outCtx = new AudioContextCtor();
    }
    console.log('[cascade] outCtx sampleRate:', this.outCtx.sampleRate);
    this._setState('idle');
  }

  async startTurn() {
    if (this.state !== 'idle') return;
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    if (this.outCtx?.state === 'suspended') await this.outCtx.resume();

    this.doneReceived = false;
    this.outQueueTime = this.outCtx.currentTime;
    this._setState('listening');

    const wsBase = this.baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const wsUrl = `${wsBase}/turn?personId=${encodeURIComponent(this.personId)}&sessionId=cas-${Date.now()}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.worklet.port.onmessage = e => {
        if (this.ws?.readyState === WebSocket.OPEN && this.state === 'listening') {
          this.ws.send(e.data);
        }
      };
      this.src.connect(this.worklet);
    };

    this.ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'transcript') {
          this.dispatchEvent(new CustomEvent('transcript', { detail: msg.transcript }));
          this._setState('thinking');
        } else if (msg.type === 'token') {
          this.dispatchEvent(new CustomEvent('token', { detail: msg.token || '' }));
        } else if (msg.type === 'done') {
          this.doneReceived = true;
          this.dispatchEvent(new CustomEvent('done', { detail: msg.latencies || {} }));
          this._maybeReturnIdle();
        } else if (msg.type === 'error') {
          this.dispatchEvent(new CustomEvent('error', { detail: msg.error || 'turn failed' }));
          this._teardownTurn();
        }
        return;
      }

      if (this.state !== 'speaking') this._setState('speaking');
      this._playPcmChunk(new Int16Array(ev.data));
    };

    this.ws.onclose = () => this._maybeReturnIdle();
    this.ws.onerror = () => {
      this.dispatchEvent(new CustomEvent('error', { detail: 'connection problem' }));
      this._teardownTurn();
    };
  }

  endTurn() {
    if (this.state !== 'listening') return;
    try { this.src.disconnect(this.worklet); } catch (_) {}
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }));
    }
    this._setState('thinking');
  }

  destroy() {
    this._teardownTurn();
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this.ctx?.close(); } catch (_) {}
    try { this.outCtx?.close(); } catch (_) {}
  }

  _teardownTurn() {
    try { this.ws?.close(); } catch (_) {}
    try { this.src?.disconnect(); } catch (_) {}
    try { this.worklet?.disconnect(); } catch (_) {}
    this._setState('idle');
  }

  _playPcmChunk(int16) {
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;
    const audioBuffer = this.outCtx.createBuffer(1, float.length, 16000);
    audioBuffer.getChannelData(0).set(float);

    const src = this.outCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.outCtx.destination);

    const now = this.outCtx.currentTime;
    const start = Math.max(now, this.outQueueTime);
    src.start(start);
    this.outQueueTime = start + audioBuffer.duration;
    src.onended = () => this._maybeReturnIdle();
  }

  _maybeReturnIdle() {
    if (!this.doneReceived) return;
    const delayMs = Math.max(0, (this.outQueueTime - this.outCtx.currentTime) * 1000) + 40;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.doneReceived && this.state !== 'listening') this._setState('idle');
    }, delayMs);
  }
}

// Mic mute + thinking indicator (Improvement 2)
let micMuted = false;
function setMic(enabled) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  micMuted = !enabled;
}
function showThinking(on) {
  el.status.textContent = on ? 'Checking my notes…' : 'Chat continuing — just speak naturally';
  el.btn.classList.toggle('thinking', on);
}

async function startShadowSttTap(stream, opts) {
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('/pcm-resampler-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-resampler');
    const wsBase = API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const ws = new WebSocket(
      `${wsBase}/shadow-stt?personId=${encodeURIComponent(opts.personId)}`
        + `&sessionId=${encodeURIComponent(opts.sessionId)}`
    );
    ws.binaryType = 'arraybuffer';

    node.port.onmessage = e => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };

    src.connect(node);

    return function stopShadow() {
      try { ws.close(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
    };
  } catch (err) {
    console.warn('[shadow-stt] tap failed (non-fatal):', err);
    return function noop() {};
  }
}

function mirrorWhisperFinal(transcript) {
  if (!shadowSessionId || !transcript) return;
  fetch(`${API_BASE}/shadow-stt/whisper`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-secret': SESSION_SECRET
    },
    body: JSON.stringify({
      personId: person,
      sessionId: shadowSessionId,
      transcript
    })
  }).catch(err => console.warn('[shadow-stt] whisper mirror failed:', err));
}

// Track accumulating function-call arguments by call_id
const pendingCalls = new Map();       // call_id → { name, argsBuffer }

// Keyed by item_id; seq preserves insertion order across concurrent events
const transcriptItems = new Map();
let seqCounter = 0;

// ──  Preflight: check backend reachability on page load ──────────────────
(async () => {
  if (!person) {
    el.greet.textContent = 'This link isn\'t valid. Please check the address.';
    document.getElementById('pinGate').style.display = 'none';
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    if (!r.ok) throw new Error('unhealthy');
    const names = { mum: 'Bev', dad: 'Tim', mil: 'Jan', jacob: 'Jacob', leanne: 'Leanne', kye: 'Kye', sam: 'Sam', keira: 'Keira' };
    el.greet.textContent = `Hi ${names[person]}, please enter your number`;
  } catch {
    el.greet.textContent = 'Chat is unavailable right now';
    setPinHint('Please try again a little later', true);
  }
})();

async function startSession() {
  activeMode = 'realtime';
  if (sessionEnded) { location.reload(); return; }
  el.btn.onclick = null;
  el.btn.classList.add('disabled');

  try {
    el.status.textContent = 'Asking for microphone permission...';
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    shadowSessionId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    stopShadowTap = await startShadowSttTap(localStream, {
      personId: person,
      sessionId: shadowSessionId
    });

    el.status.textContent = 'Connecting...';
    const tokenResp = await fetch(`${API_BASE}/session`, {
      method : 'POST',
      headers: {
        'Content-Type'     : 'application/json',
        'x-session-secret' : SESSION_SECRET
      },
      body: JSON.stringify({ person, pinToken: pinState.token })
    });
    if (!tokenResp.ok) throw new Error(`session-endpoint-${tokenResp.status}`);
    const { client_secret } = await tokenResp.json();
    if (!client_secret) throw new Error('no-client-secret-in-response');

    // ──  WebRTC setup ──────────────────────────────────────────────────────
    pc = new RTCPeerConnection();

    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = e => { audioEl.srcObject = e.streams[0]; };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    dc = pc.createDataChannel('oai-events');
    dc.onmessage = handleEvent;
    dc.onerror   = e => console.error('[dc] error:', e);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // GA SDP endpoint: /v1/realtime/calls
    const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${client_secret}`,
        'Content-Type' : 'application/sdp'
      },
      body: offer.sdp
    });
    if (!sdpResp.ok) throw new Error(`sdp-${sdpResp.status}`);
    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // ──  Session is live ───────────────────────────────────────────────────
    sessionStartTime = Date.now();
    el.btn.classList.remove('disabled');
    el.btn.classList.add('listening');
    el.btnLabel.textContent       = 'Listening';
    el.status.textContent         = 'Chat started — just speak naturally';
    el.endBtn.style.display       = 'block';
    el.transcript.style.display   = 'block';

    // Hard 30-minute cap
    maxSessionTimer = setTimeout(() => {
      if (!sessionEnded) {
        el.status.textContent = 'Wrapping up our chat...';
        endSession();
      }
    }, MAX_SESSION_MS);

  } catch (err) {
    console.error('[companion] startSession failed:', err);
    el.status.textContent = 'Could not connect. Please try again.';
    el.btn.classList.remove('disabled');
    el.btnLabel.textContent = 'Tap to Chat';
    el.btn.onclick = startSession;
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  }
}

function handleEvent(e) {
  let ev;
  try { ev = JSON.parse(e.data); } catch { return; }

  // ── Function call start ──────────────────────────────────────
  if (ev.type === 'response.output_item.added'
      && ev.item && ev.item.type === 'function_call') {
    pendingCalls.set(ev.item.call_id, { name: ev.item.name, argsBuffer: '' });
    setMic(false);
    showThinking(true);
    return;
  }

  // ── Function call args streaming ─────────────────────────────
  if (ev.type === 'response.function_call_arguments.delta') {
    const c = pendingCalls.get(ev.call_id);
    if (c) c.argsBuffer += (ev.delta || '');
    return;
  }

  // ── Function call args complete — execute ────────────────────
  if (ev.type === 'response.function_call_arguments.done') {
    const c = pendingCalls.get(ev.call_id);
    if (!c) return;
    const args = (() => { try { return JSON.parse(c.argsBuffer || '{}'); } catch { return {}; } })();
    executeFunctionCall(ev.call_id, c.name, args);
    pendingCalls.delete(ev.call_id);
    return;
  }

  // ── Full response done — unmute ──────────────────────────────
  if (ev.type === 'response.done') {
    if (micMuted) {
      setMic(true);
      showThinking(false);
    }
    return;
  }

  // ──  Assistant transcript — GA event names ─────────────────────────────
  if (ev.type === 'response.output_audio_transcript.delta') {
    const id  = ev.item_id; if (!id) return;
    const cur = transcriptItems.get(id) || { role: 'assistant', text: '', seq: seqCounter++ };
    cur.text += (ev.delta || '');
    transcriptItems.set(id, cur);
    render();
    return;
  }

  if (ev.type === 'response.output_audio_transcript.done') {
    const id = ev.item_id; if (!id) return;
    const cur = transcriptItems.get(id);
    if (cur) cur.ts = Date.now();
    render();
    return;
  }

  // ──  User transcript — fires once per turn, fully complete ────────────
  if (ev.type === 'conversation.item.input_audio_transcription.completed') {
    const id   = ev.item_id; if (!id) return;
    const text = (ev.transcript || '').trim();
    if (!text) return;
    mirrorWhisperFinal(text);
    transcriptItems.set(id, { role: 'user', text, ts: Date.now(), seq: seqCounter++ });
    render();
    return;
  }
}

async function executeFunctionCall(callId, name, args) {
  let output;

  if (name === 'search_vault') {
    try {
      const body = { person, query: args.query || '' };
      if (args.type)    body.type    = args.type;
      if (args.section) body.section = args.section;
      const r = await fetch(`${API_BASE}/vault-search`, {
        method : 'POST',
        headers: {
          'Content-Type'     : 'application/json',
          'x-session-secret' : SESSION_SECRET
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(`search-${r.status}`);
      const data = await r.json();
      // section_read and retrieval both return .answer; legacy path returns .hits
      if (data.answer !== undefined) {
        output = JSON.stringify({ answer: data.answer, source: data.source || 'unknown' });
      } else {
        output = JSON.stringify({
          hits: (data.hits || []).map(h => ({
            summary: h.summary, type: h.type, year: h.year, confidence: h.confidence
          })),
          note: data.note || null
        });
      }
    } catch (err) {
      console.error('[companion] search_vault failed:', err);
      output = JSON.stringify({ hits: [], error: 'search unavailable' });
    }
  } else {
    output = JSON.stringify({ error: 'unknown tool' });
  }

  dc.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type   : 'function_call_output',
      call_id: callId,
      output
    }
  }));

  dc.send(JSON.stringify({ type: 'response.create' }));
}

function orderedLines() {
  return Array.from(transcriptItems.values())
    .filter(x => x.text && x.text.trim())
    .sort((a, b) => a.seq - b.seq);
}

function render() {
  const lines = orderedLines().slice(-4);
  el.transcript.innerHTML = lines.map(l =>
    `<p><strong>${l.role === 'user' ? 'You' : 'Chat'}:</strong> ${esc(l.text)}</p>`
  ).join('');
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function esc(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]
  );
}

async function endSession() {
  if (sessionEnded) return;
  sessionEnded = true;
  if (maxSessionTimer) clearTimeout(maxSessionTimer);

  el.status.textContent = 'Saving your chat...';
  el.endBtn.disabled    = true;

  // Clean up WebRTC
  try {
    if (activeMode === 'cascade' && cascadeClient) {
      cascadeClient.destroy();
      cascadeClient = null;
    }
    if (dc && dc.readyState === 'open') dc.close();
    if (pc) pc.close();
    if (typeof stopShadowTap === 'function') stopShadowTap();
    stopShadowTap = null;
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (audioEl) audioEl.srcObject = null;
  } catch (e) { console.warn('[companion] cleanup warning:', e); }

  // Build final transcript and duration from live state
  const transcript = orderedLines().map(l => ({
    role: l.role,
    text: l.text,
    ts  : l.ts || null
  }));
  const duration_seconds = sessionStartTime
    ? Math.round((Date.now() - sessionStartTime) / 1000)
    : null;

  try {
    await fetch(`${API_BASE}/ingest`, {
      method : 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'x-ingest-secret' : INGEST_SECRET
      },
      body: JSON.stringify({
        person,
        transcript,
        duration_seconds,
        started_at: sessionStartTime
          ? new Date(sessionStartTime).toISOString()
          : null
      })
    });
    el.status.textContent = '✅ Thank you for chatting!';
  } catch {
    el.status.textContent = 'Chat finished. See you next time!';
  }

  el.btn.classList.remove('listening');
  el.btnLabel.textContent = 'Chat Again';
  el.btn.onclick          = () => location.reload();
  el.endBtn.style.display = 'none';
}
