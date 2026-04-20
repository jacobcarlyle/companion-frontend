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
const person = ['mum','dad','mil'].includes(params.get('person'))
  ? params.get('person') : 'mum';

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
    document.getElementById('chatControls').style.display = 'block';
    el.greet.textContent = `Welcome back! Tap when you're ready`;
  } catch {
    setPinHint('Connection problem — try again in a moment', true);
  }
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

// Keyed by item_id; seq preserves insertion order across concurrent events
const transcriptItems = new Map();
let seqCounter = 0;

// ──  Preflight: check backend reachability on page load ──────────────────
(async () => {
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    if (!r.ok) throw new Error('unhealthy');
    const names = { mum: 'Bev', dad: 'Tim', mil: 'Jan' };
    el.greet.textContent = `Hi ${names[person] || 'there'}, please enter your number`;
  } catch {
    el.greet.textContent = 'Chat is unavailable right now';
    setPinHint('Please try again a little later', true);
  }
})();

async function startSession() {
  if (sessionEnded) { location.reload(); return; }
  el.btn.onclick = null;
  el.btn.classList.add('disabled');

  try {
    el.status.textContent = 'Asking for microphone permission...';
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
    transcriptItems.set(id, { role: 'user', text, ts: Date.now(), seq: seqCounter++ });
    render();
    return;
  }
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
    if (dc && dc.readyState === 'open') dc.close();
    if (pc) pc.close();
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
