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
  lastAssistMsg: null,
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
  body.className = 'msg-body';
  body.textContent = text;

  div.appendChild(meta);
  div.appendChild(body);
  $('#conversation').appendChild(div);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;

  return div;
}

function updateMessage(el, text, opts = {}) {
  if (!el) return;
  if (text != null) el.querySelector('.msg-body').textContent = text;
  if (opts.removepartial) el.classList.remove('partial');
  if (opts.latency) {
    let lat = el.querySelector('.latency');
    if (!lat) {
      lat = document.createElement('div');
      lat.className = 'latency';
      el.appendChild(lat);
    }
    lat.textContent = opts.latency;
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
    room.startAudio();
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
        latency.stt = 0; latency.llm = 0; latency.tts = 0;
        state.currentAssistMsg = addMessage('assistant', seg.text);
        setStatus('Speaking', 'speaking');
      } else {
        updateMessage(state.currentAssistMsg, seg.text);
      }

      if (seg.final) {
        state.lastAssistMsg = state.currentAssistMsg;
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

// --- Metrics ---

const latency = { stt: 0, llm: 0, tts: 0 };

// Cumulative cost tracking
// Prices: GPT-4o-mini input $0.15/1M, output $0.60/1M, TTS-1 $15/1M chars, Deepgram STT $0.0043/min
const cost = { totalTokens: 0, promptTokens: 0, completionTokens: 0, ttsChars: 0, sttAudioMs: 0 };

function updateCostDisplay() {
  $('#cost-tokens').textContent = `${cost.promptTokens}/${cost.completionTokens}`;
  $('#cost-chars').textContent = cost.ttsChars.toString();
  const llmCost = (cost.promptTokens * 0.15 + cost.completionTokens * 0.60) / 1_000_000;
  const ttsCost = (cost.ttsChars * 15) / 1_000_000;
  const sttCost = (cost.sttAudioMs / 60_000) * 0.0043;
  const total = llmCost + ttsCost + sttCost;
  $('#cost-total').textContent = `$${total.toFixed(4)}`;
}

function updateBubbleLatency() {
  const el = state.currentAssistMsg || state.lastAssistMsg;
  if (!el) return;
  const parts = [];
  if (latency.stt > 0) parts.push(`STT ${Math.round(latency.stt)}ms`);
  if (latency.llm > 0) parts.push(`LLM ${Math.round(latency.llm)}ms`);
  if (latency.tts > 0) parts.push(`TTS ${Math.round(latency.tts)}ms`);
  const total = latency.stt + latency.llm + latency.tts;
  if (total > 0) parts.push(`= ${Math.round(total)}ms`);
  if (parts.length > 0) updateMessage(el, null, { latency: parts.join(' · ') });
}

// --- Event Log ---

function logEvent(type, body) {
  const log = $('#event-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-type ${type}">${type}</span><span class="log-body">${body}</span>`;

  // Only auto-scroll if user is near the bottom
  const isNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  log.appendChild(entry);
  if (isNearBottom) log.scrollTop = log.scrollHeight;
}

function copyLog() {
  const log = $('#event-log');
  const entries = log.querySelectorAll('.log-entry');
  const text = Array.from(entries).map(e => {
    const time = e.querySelector('.log-time')?.textContent || '';
    const type = e.querySelector('.log-type')?.textContent || '';
    const body = e.querySelector('.log-body')?.textContent || '';
    return `${time}\t${type}\t${body}`;
  }).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('#copy-log-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  });
}

$('#copy-log-btn').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  copyLog();
});

function formatMetrics(msg) {
  const parts = [];
  if (msg.sttDuration != null) parts.push(`STT ${Math.round(msg.sttDuration)}ms (${msg.sttAudioMs || 0}ms audio)`);
  if (msg.llmDuration != null) parts.push(`LLM ${Math.round(msg.llmDuration)}ms (${msg.llmPromptTokens || 0}+${msg.llmCompletionTokens || 0} tok, ${Math.round(msg.llmTokensPerSec || 0)} t/s)`);
  if (msg.ttsDuration != null) parts.push(`TTS ${Math.round(msg.ttsDuration)}ms (${msg.ttsChars || 0} chars)`);
  return parts.join(' | ');
}

room.on(RoomEvent.DataReceived, (data, participant) => {
  try {
    const msg = JSON.parse(new TextDecoder().decode(data));

    // Metrics handling (latency bar + bubble + cost)
    if (msg.type === 'metrics') {
      if (msg.sttDuration != null) { latency.stt = msg.sttDuration; $('#lat-stt').textContent = `${Math.round(latency.stt)}ms`; }
      if (msg.llmDuration != null) { latency.llm = msg.llmDuration; $('#lat-llm').textContent = `${Math.round(latency.llm)}ms`; }
      if (msg.ttsDuration != null) { latency.tts = msg.ttsDuration; $('#lat-tts').textContent = `${Math.round(latency.tts)}ms`; }
      const total = latency.stt + latency.llm + latency.tts;
      if (total > 0) $('#lat-total').textContent = `${Math.round(total)}ms`;
      updateBubbleLatency();

      // Accumulate cost
      if (msg.llmPromptTokens) { cost.promptTokens += msg.llmPromptTokens; cost.completionTokens += msg.llmCompletionTokens || 0; cost.totalTokens += msg.llmTotalTokens || 0; }
      if (msg.ttsChars) cost.ttsChars += msg.ttsChars;
      if (msg.sttAudioMs) cost.sttAudioMs += msg.sttAudioMs;
      updateCostDisplay();

      logEvent('metrics', formatMetrics(msg));
    }

    // State changes
    else if (msg.type === 'state') {
      logEvent('state', `${msg.oldState} → ${msg.newState}`);
    }

    // STT final transcript
    else if (msg.type === 'stt') {
      logEvent('stt', msg.transcript);
    }

    // Tool call
    else if (msg.type === 'tool_call') {
      logEvent('tool_call', `${msg.name}(${msg.args})`);
    }

    // Tool result
    else if (msg.type === 'tool_result') {
      logEvent('tool_result', `${msg.name} → ${msg.result}`);
    }

    // Errors
    else if (msg.type === 'error') {
      logEvent('error', `${msg.reason}${msg.error ? ': ' + msg.error : ''}`);
    }

    // LLM send (what we sent to Claude)
    else if (msg.type === 'llm_send') {
      logEvent('llm_send', msg.text);
    }

    // LLM receive (sentence from Claude)
    else if (msg.type === 'llm_recv') {
      logEvent('llm_recv', msg.text);
    }

    // Agent SDK events
    else if (msg.type === 'agent_sdk') {
      logEvent('agent', `${msg.event}${msg.state ? ': ' + msg.state : ''}${msg.cost != null ? ' ($' + msg.cost.toFixed(4) + ')' : ''}${msg.error ? ': ' + msg.error : ''}`);
    }

    // Tool use (Claude Agent SDK)
    else if (msg.type === 'tool_use') {
      logEvent('tool_call', `${msg.title || msg.tool}: ${msg.input}`);
    }

    // Tool denied
    else if (msg.type === 'tool_denied') {
      logEvent('error', `DENIED ${msg.tool}: ${msg.reason}`);
    }
  } catch (e) { console.warn('Failed to parse data message:', e); }
});
