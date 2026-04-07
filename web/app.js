import {
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs';

const $ = (sel) => document.querySelector(sel);
const room = new Room({ adaptiveStream: true, dynacast: true });

// --- Server health check ---
async function checkServerHealth() {
  const el = $('#server-status');
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      el.textContent = 'Server: OK';
      el.className = 'server-status ok';
    } else {
      el.textContent = 'Server: Error';
      el.className = 'server-status error';
    }
  } catch {
    el.textContent = 'Server: Offline';
    el.className = 'server-status error';
  }
}
checkServerHealth();
setInterval(checkServerHealth, 10000);

// --- Theme toggle ---
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') document.body.classList.add('light');
  else if (saved === 'dark') document.body.classList.add('dark');
  updateThemeBtn();
}
function updateThemeBtn() {
  const isLight = document.body.classList.contains('light') ||
    (!document.body.classList.contains('dark') && window.matchMedia('(prefers-color-scheme: light)').matches);
  $('#theme-btn').textContent = isLight ? '🌙' : '☀️';
}
$('#theme-btn').addEventListener('click', () => {
  const isCurrentlyLight = document.body.classList.contains('light') ||
    (!document.body.classList.contains('dark') && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.body.classList.remove('light', 'dark');
  if (isCurrentlyLight) {
    document.body.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.add('light');
    localStorage.setItem('theme', 'light');
  }
  updateThemeBtn();
});
initTheme();

const state = {
  connected: false,
  currentUserMsg: null,
  currentAssistMsg: null,
  lastAssistMsg: null,
};

// --- Session state ---
const sessionState = {
  currentSessionId: null,
  viewingSessionId: null,
  sessions: [],
  pendingResumeSessionId: null, // set before connect, sent when agent is ready
};

// --- Sidebar toggle (mobile) ---
$('#hamburger-btn').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#sidebar-overlay').classList.add('open');
});
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#sidebar-overlay').addEventListener('click', closeSidebar);

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('open');
}

// --- Session list ---
async function fetchSessions(query) {
  const url = query ? `/api/sessions?q=${encodeURIComponent(query)}` : '/api/sessions';
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    sessionState.sessions = await res.json();
    renderSessionList();
    updateSessionBar();
  } catch (err) {
    console.error('Failed to fetch sessions:', err);
  }
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of sessionState.sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    if (s.sessionId === sessionState.currentSessionId) div.classList.add('active');
    if (s.sessionId === sessionState.viewingSessionId) div.classList.add('viewing');
    div.dataset.sessionId = s.sessionId;

    const date = new Date(s.updated);
    const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
    const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
      <div class="session-preview">${escapeHtml(s.name || s.preview)}</div>
      <div class="session-meta">${dateStr} ${timeStr} · ${s.messageCount} zpráv</div>
    `;
    div.addEventListener('click', () => onSessionClick(s.sessionId));
    list.appendChild(div);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch sessions on load
fetchSessions();

// --- Session name ---
function updateSessionBar() {
  const bar = $('#session-bar');
  const nameEl = $('#session-name');
  const metaEl = $('#session-meta');
  const resumeBtn = $('#resume-btn');
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;
  if (!targetId) {
    bar.style.display = 'none';
    return;
  }
  const session = sessionState.sessions.find(s => s.sessionId === targetId);
  bar.style.display = 'flex';
  nameEl.textContent = session?.name || session?.preview || 'Untitled';
  // Meta info (date + count)
  if (session) {
    const date = new Date(session.created);
    const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    metaEl.textContent = `${dateStr} ${timeStr} · ${session.messageCount} zpráv`;
  } else {
    metaEl.textContent = '';
  }
  // Resume button only in read-only mode
  resumeBtn.style.display = sessionState.viewingSessionId ? '' : 'none';
}

$('#session-name').addEventListener('blur', async () => {
  const name = $('#session-name').textContent.trim();
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;
  if (!name || !targetId) return;
  await fetch(`/api/sessions/${targetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  fetchSessions();
});

$('#session-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#session-name').blur(); }
});

$('#generate-name-btn').addEventListener('click', async () => {
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;
  if (!targetId) return;
  const btn = $('#generate-name-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch(`/api/sessions/${targetId}/generate-name`, { method: 'POST' });
    if (res.ok) {
      const { name } = await res.json();
      $('#session-name').textContent = name;
      fetchSessions();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✨';
  }
});

// --- Search ---
let searchTimeout = null;
$('#session-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    fetchSessions(e.target.value.trim() || undefined);
  }, 300);
});

async function onSessionClick(sessionId) {
  // If clicking the active session while connected, just close sidebar
  if (sessionId === sessionState.currentSessionId && state.connected) {
    closeSidebar();
    return;
  }

  // Disconnect voice if active
  if (state.connected) {
    room.disconnect();
  }

  // Clear active session — we're now browsing history
  sessionState.currentSessionId = null;

  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return;
    const session = await res.json();
    showReadOnlyTranscript(session);
    sessionState.viewingSessionId = sessionId;
    renderSessionList();
    updateSessionBar();
    closeSidebar();
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

function showReadOnlyTranscript(session) {
  $('#readonly-footer').style.display = 'block';
  $('#toolbar').style.display = 'none';

  const conv = $('#conversation');
  conv.innerHTML = '';
  for (const msg of session.messages) {
    if (msg.role === 'tool') continue;
    const div = document.createElement('div');
    div.className = `msg ${msg.role === 'user' ? 'user' : 'assistant'}`;

    const time = new Date(msg.timestamp);
    const ts = time.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${msg.role === 'user' ? 'Ty' : 'Asistent'} · ${ts}`;

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = msg.text;

    div.appendChild(meta);
    div.appendChild(body);
    conv.appendChild(div);
  }
  conv.scrollTop = conv.scrollHeight;

  $('#resume-btn').onclick = () => resumeSession(session.sessionId);
}

function exitReadOnlyMode() {
  sessionState.viewingSessionId = null;
  $('#readonly-footer').style.display = 'none';
  $('#toolbar').style.display = '';
  $('#conversation').innerHTML = '';
  renderSessionList();
  updateSessionBar();
}

async function resumeSession(sessionId) {
  // Load transcript before clearing read-only mode
  let sessionData = null;
  try {
    const sessionRes = await fetch(`/api/sessions/${sessionId}`);
    if (sessionRes.ok) sessionData = await sessionRes.json();
  } catch {}

  exitReadOnlyMode();

  // Restore previous messages into live chat
  if (sessionData) {
    for (const msg of sessionData.messages) {
      if (msg.role === 'tool') continue;
      addMessage(msg.role === 'user' ? 'user' : 'assistant', msg.text);
    }
  }

  try {
    const res = await fetch(`/api/token?session=${sessionId}`);
    const { token } = await res.json();

    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const livekitUrl = $('#app').dataset.livekitUrl || `${wsProto}://${window.location.hostname}:7880`;
    await room.connect(livekitUrl, token);

    state.connected = true;
    setStatus('Connected', 'connected');
    $('#connect-btn').disabled = true;
    $('#disconnect-btn').disabled = false;
    $('#mic-btn').disabled = false;
    $('#hold-btn').disabled = false;
    $('#mic-label').textContent = 'Click to toggle microphone';

    // Don't send session_init yet — wait for agent's session_info (= agent is ready)
    sessionState.pendingResumeSessionId = sessionId;

    await room.localParticipant.setMicrophoneEnabled(true);
    $('#mic-btn').classList.add('active');
    $('#mic-label').textContent = 'Listening...';
    setStatus('Listening', 'listening');
  } catch (err) {
    console.error('Resume failed:', err);
    addMessage('assistant', `Resume error: ${err?.message || err}`);
  }
}

$('#new-session-btn').addEventListener('click', () => {
  if (state.connected) {
    room.disconnect();
  }
  exitReadOnlyMode();
  closeSidebar();
});

// --- Text input ---
$('#text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});
$('#text-send-btn').addEventListener('click', sendTextMessage);

async function sendTextMessage() {
  const input = $('#text-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  // If viewing a read-only transcript, resume that session
  const targetSessionId = sessionState.viewingSessionId || sessionState.currentSessionId;
  if (sessionState.viewingSessionId) {
    exitReadOnlyMode();
  }

  // Show user message in chat
  addMessage('user', text);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        sessionId: targetSessionId || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      addMessage('assistant', `Error: ${err.error || res.statusText}`);
      return;
    }

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));

        if (data.type === 'session_info') {
          sessionState.currentSessionId = data.sessionId;
          renderSessionList();
          fetchSessions(); // refresh to get name
        } else if (data.type === 'text') {
          if (!state.currentAssistMsg) {
            // Reset latency for text response (no STT/TTS)
            latency.stt = 0; latency.llm = 0; latency.tts = 0;
            $('#lat-stt').textContent = '—'; $('#lat-tts').textContent = '—';
            $('#lat-llm').textContent = '—'; $('#lat-total').textContent = '—';
            state.currentAssistMsg = addMessage('assistant', data.text);
          } else {
            const body = state.currentAssistMsg.querySelector('.msg-body');
            body.textContent += ' ' + data.text;
            $('#conversation').scrollTop = $('#conversation').scrollHeight;
          }
        } else if (data.type === 'event') {
          // Forward agent events to server event log
          const evt = data.event;
          if (evt.type === 'llm_send') logEvent('llm_send', evt.text);
          else if (evt.type === 'llm_recv') logEvent('llm_recv', evt.text);
          else if (evt.type === 'metrics') {
            const parts = [];
            if (evt.llmDuration != null) parts.push(`LLM ${Math.round(evt.llmDuration)}ms`);
            if (parts.length) logEvent('metrics', parts.join(' | '));
            // Update latency bar for LLM
            if (evt.llmDuration != null) {
              latency.llm = evt.llmDuration;
              $('#lat-llm').textContent = `${Math.round(evt.llmDuration)}ms`;
              const total = latency.llm;
              $('#lat-total').textContent = `${Math.round(total)}ms`;
              updateBubbleLatency();
            }
          }
          else if (evt.type === 'tool_call') logEvent('tool_call', `${evt.name}: ${evt.input}`);
          else if (evt.type === 'tool_use') logEvent('tool_call', `${evt.tool}: ${evt.input}`);
          else if (evt.type === 'agent_sdk') logEvent('agent', `${evt.event}${evt.cost != null ? ' ($' + evt.cost.toFixed(4) + ')' : ''}`);
        } else if (data.type === 'done') {
          if (state.currentAssistMsg) {
            state.lastAssistMsg = state.currentAssistMsg;
            state.currentAssistMsg = null;
          }
          sessionState.currentSessionId = data.sessionId;
          fetchSessions();
        } else if (data.type === 'error') {
          addMessage('assistant', `Error: ${data.error}`);
        }
      }
    }
  } catch (err) {
    console.error('Text chat failed:', err);
    addMessage('assistant', `Error: ${err?.message || err}`);
  }
}

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
    // Set pending resume BEFORE connecting — agent sends session_info
    // immediately after connect, so pendingResumeSessionId must be ready
    if (sessionState.currentSessionId) {
      sessionState.pendingResumeSessionId = sessionState.currentSessionId;
    }

    if (!state.connected) {
      const res = await fetch('/api/token');
      const { token } = await res.json();

      const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const livekitUrl = $('#app').dataset.livekitUrl || `${wsProto}://${window.location.hostname}:7880`;
      console.log('Connecting to LiveKit:', livekitUrl);
      await room.connect(livekitUrl, token);
      state.connected = true;
    }

    // Enable voice mode (mic + controls)
    setStatus('Connected', 'connected');
    $('#connect-btn').disabled = true;
    $('#disconnect-btn').disabled = false;
    $('#mic-btn').disabled = false;
    $('#hold-btn').disabled = false;
    $('#mic-label').textContent = 'Click to toggle microphone';

    await room.localParticipant.setMicrophoneEnabled(true);
    $('#mic-btn').classList.add('active');
    $('#mic-label').textContent = 'Listening...';
    setStatus('Listening', 'listening');
  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('Error', 'disconnected');
    const errMsg = err?.message || String(err);
    addMessage('assistant', `Connection error: ${errMsg}`);
    logEvent('error', `Connect failed: ${errMsg}`);
  }
});

$('#disconnect-btn').addEventListener('click', () => {
  room.disconnect();
});

// --- LLM Hold ---
let llmHeld = false;

$('#hold-btn').addEventListener('click', () => {
  if (!state.connected) return;

  if (!llmHeld) {
    // Switch to Hold mode
    llmHeld = true;
    $('#hold-btn').textContent = 'LLM: Send';
    $('#hold-btn').classList.add('held');
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'llm_hold', held: true })),
      { reliable: true }
    );
    logEvent('agent', 'LLM hold ON — transcripts buffered');
  } else {
    // Release — send buffered transcripts
    llmHeld = false;
    $('#hold-btn').textContent = 'LLM: Auto';
    $('#hold-btn').classList.remove('held');
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'llm_hold', held: false })),
      { reliable: true }
    );
    logEvent('agent', 'LLM hold OFF — sending to Claude');
  }
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
  $('#hold-btn').disabled = true;
  $('#hold-btn').textContent = 'LLM: Auto';
  $('#hold-btn').classList.remove('held');
  llmHeld = false;
  // Finalize any in-progress assistant message
  if (state.currentAssistMsg) {
    state.lastAssistMsg = state.currentAssistMsg;
    state.currentAssistMsg = null;
  }
  // Keep currentSessionId — text chat should continue in the same session after voice disconnect
  fetchSessions();
  renderSessionList();
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
      // Finalize user bubble when agent starts responding
      if (state.currentUserMsg) {
        state.currentUserMsg = null;
        state.userMsgFinal = '';
      }
      if (!state.currentAssistMsg) {
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
        // Reset latencies when new user turn starts
        latency.stt = 0; latency.llm = 0; latency.tts = 0;
        state.currentUserMsg = addMessage('user', seg.text, { partial: true });
        state.userMsgFinal = '';
      }

      if (seg.final) {
        // Append final segment to coalesced text
        state.userMsgFinal += (state.userMsgFinal ? ' ' : '') + seg.text;
        updateMessage(state.currentUserMsg, state.userMsgFinal, { removepartial: true });
        // Don't finalize here — finalized when agent starts responding
      } else {
        // Partial — show finalized text + current partial
        const display = state.userMsgFinal
          ? state.userMsgFinal + ' ' + seg.text
          : seg.text;
        updateMessage(state.currentUserMsg, display);
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
  const llmCost = (cost.promptTokens * 0.15 + cost.completionTokens * 0.60) / 1_000_000;
  const ttsCost = (cost.ttsChars * 15) / 1_000_000;
  const sttCost = (cost.sttAudioMs / 60_000) * 0.0043;
  const total = llmCost + ttsCost + sttCost;
  $('#cost-total').textContent = `$${total.toFixed(4)}`;
}

function updateBubbleLatency() {
  // Latency shown only in toolbar metrics bar — removed from bubbles
  // (metrics arrive asynchronously and don't map 1:1 to bubbles)
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
      logEvent('tool_call', `${msg.name}: ${msg.input}`);
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

    // Session info from agent
    else if (msg.type === 'session_info') {
      // If we have a pending resume, send session_init now that agent is ready
      if (sessionState.pendingResumeSessionId) {
        const resumeId = sessionState.pendingResumeSessionId;
        sessionState.pendingResumeSessionId = null;
        room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ type: 'session_init', sessionId: resumeId })),
          { reliable: true }
        );
        // Don't update currentSessionId yet — wait for agent's response with correct session
        return;
      }
      sessionState.currentSessionId = msg.sessionId;
      sessionState.viewingSessionId = null;
      renderSessionList();
      fetchSessions();
    }

  } catch (e) { console.warn('Failed to parse data message:', e); }
});
