import {
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs';

const $ = (sel) => document.querySelector(sel);
const room = new Room({ adaptiveStream: true, dynacast: true });

const state = {
  connected: false,
  currentUserMsg: null,
  currentAssistMsg: null,
};

// --- UI Helpers ---

function setStatus(text, cls) {
  const el = $('#status');
  el.textContent = `● ${text}`;
  el.className = `status ${cls}`;
}

function addMessage(role, text, opts = {}) {
  const div = document.createElement('div');
  div.className = `msg ${role}${opts.partial ? ' partial' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = role === 'user' ? 'Ty' : 'Asistent';
  if (opts.latency) meta.textContent += ` · ${opts.latency}ms`;

  const body = document.createElement('div');
  body.textContent = text;

  div.appendChild(meta);
  div.appendChild(body);
  $('#conversation').appendChild(div);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;

  return div;
}

function updateMessage(el, text, opts = {}) {
  if (!el) return;
  el.querySelector('div:last-child').textContent = text;
  if (opts.removepartial) el.classList.remove('partial');
  if (opts.latency) {
    let lat = el.querySelector('.latency');
    if (!lat) {
      lat = document.createElement('div');
      lat.className = 'latency';
      el.appendChild(lat);
    }
    lat.textContent = `${opts.latency}ms`;
  }
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
}

// --- Connection ---

$('#connect-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/token?room=voice-room');
    const { token } = await res.json();

    await room.connect($('#app').dataset.livekitUrl || 'ws://localhost:7880', token);

    state.connected = true;
    setStatus('Connected', 'connected');
    $('#connect-btn').disabled = true;
    $('#disconnect-btn').disabled = false;
    $('#mic-btn').disabled = false;
    $('#mic-label').textContent = 'Click to toggle microphone';

    await room.localParticipant.setMicrophoneEnabled(true);
    $('#mic-btn').classList.add('active');
    $('#mic-label').textContent = 'Listening...';
    setStatus('Listening', 'listening');
  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('Error', 'disconnected');
  }
});

$('#disconnect-btn').addEventListener('click', () => {
  room.disconnect();
});

$('#mic-btn').addEventListener('click', async () => {
  if (!state.connected) return;
  const enabled = room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(!enabled);
  $('#mic-btn').classList.toggle('active', !enabled);
  $('#mic-label').textContent = !enabled ? 'Listening...' : 'Microphone off';
  setStatus(!enabled ? 'Listening' : 'Connected', !enabled ? 'listening' : 'connected');
});

// --- Room Events ---

room.on(RoomEvent.Disconnected, () => {
  state.connected = false;
  setStatus('Disconnected', 'disconnected');
  $('#connect-btn').disabled = false;
  $('#disconnect-btn').disabled = true;
  $('#mic-btn').disabled = true;
  $('#mic-btn').classList.remove('active');
  $('#mic-label').textContent = 'Connect to start';
});

room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
  if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.id = `audio-${participant.identity}`;
    document.body.appendChild(el);
  }
});

room.on(RoomEvent.TrackUnsubscribed, (track) => {
  track.detach().forEach((el) => el.remove());
});

// --- Transcription Events ---

room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
  const isAgent = participant?.identity?.startsWith('agent');

  for (const seg of segments) {
    if (isAgent) {
      if (!state.currentAssistMsg) {
        state.currentAssistMsg = addMessage('assistant', seg.text);
        setStatus('Speaking', 'speaking');
      } else {
        const current = state.currentAssistMsg.querySelector('div:last-child').textContent;
        updateMessage(state.currentAssistMsg, current + seg.text);
      }

      if (seg.final) {
        state.currentAssistMsg = null;
        setStatus('Listening', 'listening');
      }
    } else {
      if (!state.currentUserMsg) {
        state.currentUserMsg = addMessage('user', seg.text, { partial: !seg.final });
      } else {
        updateMessage(state.currentUserMsg, seg.text);
      }

      if (seg.final) {
        updateMessage(state.currentUserMsg, seg.text, { removepartial: true });
        state.currentUserMsg = null;
      }
    }
  }
});

// --- Metrics (placeholder for Task 6) ---

room.on(RoomEvent.DataReceived, (data, participant) => {
  try {
    const msg = JSON.parse(new TextDecoder().decode(data));
    if (msg.type === 'metrics') {
      if (msg.sttDuration != null) $('#lat-stt').textContent = `${Math.round(msg.sttDuration)}ms`;
      if (msg.llmDuration != null) $('#lat-llm').textContent = `${Math.round(msg.llmDuration)}ms`;
      if (msg.ttsDuration != null) $('#lat-tts').textContent = `${Math.round(msg.ttsDuration)}ms`;
      const total = (msg.sttDuration || 0) + (msg.llmDuration || 0) + (msg.ttsDuration || 0);
      if (total > 0) $('#lat-total').textContent = `${Math.round(total)}ms`;
    }
  } catch {}
});
