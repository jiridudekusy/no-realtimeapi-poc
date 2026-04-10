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
  viewingFile: null,
  sessions: [],
  pendingResumeSessionId: null, // set before connect, sent when agent is ready
  currentProject: localStorage.getItem('currentProject') || '_global',
  pendingResumeProject: null,
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

// --- Project tree ---
let cachedTreeData = { globalChats: [], projects: [] };

async function fetchProjectTree() {
  try {
    const projectsRes = await fetch('/api/projects');
    const projects = projectsRes.ok ? await projectsRes.json() : [];

    const globalRes = await fetch('/api/projects/_global/sessions');
    const globalChats = globalRes.ok ? await globalRes.json() : [];

    const projectData = await Promise.all(projects.map(async (p) => {
      const res = await fetch(`/api/projects/${p.name}/sessions`);
      const chats = res.ok ? await res.json() : [];
      return { ...p, chats };
    }));

    cachedTreeData = { globalChats, projects: projectData };
    renderProjectTree(globalChats, projectData);
    updateSessionBar();
  } catch (err) {
    console.error('Failed to fetch project tree:', err);
  }
}

function getProjectDisplayName(projectName) {
  if (projectName === '_global') return null;
  const p = cachedTreeData.projects.find(p => p.name === projectName);
  return p?.displayName || p?.name || projectName;
}

function renderProjectTree(globalChats, projects) {
  const tree = $('#project-tree');
  tree.innerHTML = '';
  tree.appendChild(createProjectGroup('_global', '🏠 Home', null, globalChats, false));
  for (const p of projects) {
    tree.appendChild(createProjectGroup(p.name, '📁 ' + (p.displayName || p.name), p.description, p.chats, true));
  }
}

function createProjectGroup(projectName, displayName, description, chats, canDelete) {
  const group = document.createElement('div');
  group.className = 'project-group';

  const isActive = sessionState.currentProject === projectName;
  const isExpanded = isActive || (chats.length > 0 && chats.length <= 3);

  const header = document.createElement('div');
  header.className = 'project-header' + (isActive ? ' active' : '');
  header.innerHTML =
    '<span class="project-toggle">' + (isExpanded ? '▼' : '▶') + '</span>' +
    '<span class="project-name">' + escapeHtml(displayName) + '</span>' +
    (!isExpanded && chats.length > 0 ? '<span class="project-count">(' + chats.length + ')</span>' : '') +
    (canDelete ? '<button class="project-delete" title="Delete project">✕</button>' : '');

  header.addEventListener('click', (e) => {
    if (e.target.closest('.project-delete')) return;
    // Set as current project
    setCurrentProject(projectName);
    updateSessionBar();
    // Toggle collapse
    const chatsDiv = group.querySelector('.project-chats');
    const toggle = header.querySelector('.project-toggle');
    chatsDiv.classList.toggle('collapsed');
    toggle.textContent = chatsDiv.classList.contains('collapsed') ? '▶' : '▼';
    // Update active highlights
    document.querySelectorAll('.project-header').forEach(h => h.classList.remove('active'));
    header.classList.add('active');
  });

  if (canDelete) {
    header.querySelector('.project-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteProjectModal(projectName);
    });
  }

  group.appendChild(header);

  const chatsDiv = document.createElement('div');
  chatsDiv.className = 'project-chats' + (isExpanded ? '' : ' collapsed');

  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.sessionId === sessionState.currentSessionId && projectName === sessionState.currentProject ? ' active' : '');
    const age = getTimeAgo(chat.updated);
    item.innerHTML =
      '<span class="chat-item-text">' + escapeHtml(chat.name || chat.preview) + '</span>' +
      '<span class="chat-item-meta">' + age + '</span>' +
      '<button class="chat-item-delete" title="Delete chat">🗑</button>';

    item.addEventListener('click', (e) => {
      if (e.target.closest('.chat-item-delete')) return;
      onSessionClick(chat.sessionId, projectName);
    });

    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteSessionModal(projectName, chat.sessionId);
    });

    chatsDiv.appendChild(item);
  }

  group.appendChild(chatsDiv);
  return group;
}

function getTimeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.floor(hours / 24);
  return days + 'd';
}

function findSessionInTree(sessionId) {
  for (const chat of cachedTreeData.globalChats) {
    if (chat.sessionId === sessionId) return chat;
  }
  for (const p of cachedTreeData.projects) {
    for (const chat of p.chats) {
      if (chat.sessionId === sessionId) return chat;
    }
  }
  return null;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch project tree on load
fetchProjectTree();

// --- Session name ---
function updateSessionBar() {
  const bar = $('#session-bar');
  const projectEl = $('#breadcrumb-project');
  const nameEl = $('#session-name');
  const metaEl = $('#session-meta');
  const resumeBtn = $('#resume-btn');
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;

  if (sessionState.viewingFile) {
    bar.style.display = 'flex';
    const project = sessionState.currentProject || '_global';
    projectEl.textContent = project === '_global' ? '🏠 Home' : '📁 ' + getProjectDisplayName(project);
    nameEl.textContent = '📄 ' + sessionState.viewingFile;
    nameEl.contentEditable = 'false';
    $('#generate-name-btn').style.display = 'none';
    metaEl.textContent = '';
    resumeBtn.style.display = 'none';
    return;
  }

  if (!targetId) {
    if (sessionState.currentProject && sessionState.currentProject !== '_global') {
      bar.style.display = 'flex';
      projectEl.textContent = '📁 ' + getProjectDisplayName(sessionState.currentProject);
      nameEl.textContent = '';
      metaEl.textContent = '';
      resumeBtn.style.display = 'none';
      $('#generate-name-btn').style.display = 'none';
      return;
    }
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  const project = sessionState.currentProject || '_global';
  projectEl.textContent = project === '_global' ? '🏠 Home' : '📁 ' + getProjectDisplayName(project);

  const session = findSessionInTree(targetId);
  nameEl.textContent = session?.name || session?.preview || 'Untitled';
  nameEl.contentEditable = sessionState.viewingSessionId ? 'false' : 'true';
  $('#generate-name-btn').style.display = '';

  if (session) {
    const date = new Date(session.created);
    const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    metaEl.textContent = dateStr + ' ' + timeStr + ' · ' + session.messageCount + ' zpráv';
  } else {
    metaEl.textContent = '';
  }

  resumeBtn.style.display = sessionState.viewingSessionId ? '' : 'none';
}

$('#session-name').addEventListener('blur', async () => {
  const name = $('#session-name').textContent.trim();
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;
  if (!name || !targetId) return;
  await fetch(`/api/projects/${sessionState.currentProject}/sessions/${targetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  fetchProjectTree();
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
    const res = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${targetId}/generate-name`, { method: 'POST' });
    if (res.ok) {
      const { name } = await res.json();
      $('#session-name').textContent = name;
      fetchProjectTree();
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
    const query = e.target.value.trim();
    if (query) {
      fetchProjectTreeFiltered(query);
    } else {
      fetchProjectTree();
    }
  }, 300);
});

async function fetchProjectTreeFiltered(query) {
  try {
    const projectsRes = await fetch('/api/projects');
    const projects = projectsRes.ok ? await projectsRes.json() : [];

    const globalRes = await fetch('/api/projects/_global/sessions?q=' + encodeURIComponent(query));
    const globalChats = globalRes.ok ? await globalRes.json() : [];

    const projectData = await Promise.all(projects.map(async (p) => {
      const res = await fetch('/api/projects/' + p.name + '/sessions?q=' + encodeURIComponent(query));
      const chats = res.ok ? await res.json() : [];
      return { ...p, chats };
    }));

    const filtered = projectData.filter(p => p.chats.length > 0);
    renderProjectTree(globalChats, filtered);
  } catch (err) {
    console.error('Failed to search:', err);
  }
}

function setCurrentProject(name) {
  sessionState.currentProject = name || '_global';
  localStorage.setItem('currentProject', sessionState.currentProject);
}

async function onSessionClick(sessionId, projectName) {
  if (sessionId === sessionState.currentSessionId && projectName === sessionState.currentProject && state.connected) {
    closeSidebar();
    return;
  }

  if (state.connected) {
    room.disconnect();
  }

  setCurrentProject(projectName);
  sessionState.currentSessionId = null;

  try {
    const res = await fetch('/api/projects/' + sessionState.currentProject + '/sessions/' + sessionId);
    if (!res.ok) return;
    const session = await res.json();
    showReadOnlyTranscript(session);
    sessionState.viewingSessionId = sessionId;
    fetchProjectTree();
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
  fetchProjectTree();
  updateSessionBar();
}

async function resumeSession(sessionId) {
  // Load transcript before clearing read-only mode
  let sessionData = null;
  try {
    const sessionRes = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${sessionId}`);
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
  sessionState.currentSessionId = null;
  sessionState.viewingSessionId = null;
  $('#conversation').innerHTML = '';
  closeSidebar();
  updateSessionBar();
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
  showThinking();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        sessionId: targetSessionId || undefined,
        projectName: sessionState.currentProject || '_global',
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
          fetchProjectTree();
        } else if (data.type === 'text') {
          removeThinking();
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
          fetchProjectTree();
        } else if (data.type === 'context_switched') {
          setCurrentProject(data.projectName);
          sessionState.currentSessionId = data.sessionId;
          // Clear conversation for the new project context
          // (text chat — not voice, so no active bubbles to preserve)
          $('#conversation').innerHTML = '';
          fetchProjectTree();
          updateSessionBar();
        } else if (data.type === 'error') {
          removeThinking();
          cancelThinkingSound();
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

// --- Thinking audio (voice mode only) ---
let thinkingAudioCtx = null;
let thinkingInterval = null;
let thinkingSoundTimer = null;

function scheduleThinkingSound(delayMs = 0) {
  cancelThinkingSound();
  if (!state.connected) return;
  if (delayMs <= 0) {
    startThinkingSound();
  } else {
    thinkingSoundTimer = setTimeout(() => {
      thinkingSoundTimer = null;
      startThinkingSound();
    }, delayMs);
  }
}

function cancelThinkingSound() {
  if (thinkingSoundTimer) { clearTimeout(thinkingSoundTimer); thinkingSoundTimer = null; }
  stopThinkingSound();
}

function playThinkingPulse() {
  if (!thinkingAudioCtx) return;
  const ctx = thinkingAudioCtx;
  const now = ctx.currentTime;
  const dur = 2.5;
  const bufSize = ctx.sampleRate * dur;
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(200, now);
  filter.frequency.linearRampToValueAtTime(1200, now + 1.2);
  filter.frequency.linearRampToValueAtTime(200, now + dur);
  filter.Q.value = 1;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.025, now + 0.5);
  gain.gain.setValueAtTime(0.025, now + 1.8);
  gain.gain.linearRampToValueAtTime(0, now + dur);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(now); src.stop(now + dur);
}

function startThinkingSound() {
  stopThinkingSound();
  try {
    thinkingAudioCtx = new AudioContext();
    playThinkingPulse();
    thinkingInterval = setInterval(playThinkingPulse, 3500);
  } catch {}
}

function stopThinkingSound() {
  if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
  if (thinkingAudioCtx) { thinkingAudioCtx.close().catch(() => {}); thinkingAudioCtx = null; }
}

function showThinking() {
  removeThinking();
  const div = document.createElement('div');
  div.className = 'msg assistant thinking';
  div.id = 'thinking-indicator';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'Asistent';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
  div.appendChild(meta);
  div.appendChild(body);
  $('#conversation').appendChild(div);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
}

function removeThinking() {
  const el = document.getElementById('thinking-indicator');
  if (el) el.remove();
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
    // Always send project context, even without a session (new chat in a project)
    sessionState.pendingResumeSessionId = sessionState.currentSessionId || '__new__';
    sessionState.pendingResumeProject = sessionState.currentProject;

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
  cancelThinkingSound();
  removeThinking();
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
  fetchProjectTree();
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
      removeThinking();
      cancelThinkingSound();
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
      // User is speaking — stop any thinking sound
      cancelThinkingSound();
      removeThinking();
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

room.on(RoomEvent.DataReceived, async (data, participant) => {
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

    // Tool call — agent is working, schedule thinking sound with delay
    else if (msg.type === 'tool_call') {
      logEvent('tool_call', `${msg.name}: ${msg.input}`);
      showThinking();
      scheduleThinkingSound(500);
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

    // Tool use (Claude Agent SDK) — agent is working, schedule thinking sound with delay
    else if (msg.type === 'tool_use') {
      logEvent('tool_call', `${msg.title || msg.tool}: ${msg.input}`);
      showThinking();
      scheduleThinkingSound(500);
    }

    // Thinking indicator (agent started processing via voice) — immediate
    else if (msg.type === 'thinking') {
      showThinking();
      scheduleThinkingSound(0);
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
        const initSessionId = resumeId === '__new__' ? undefined : resumeId;
        room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({
            type: 'session_init',
            sessionId: initSessionId,
            projectName: sessionState.pendingResumeProject || '_global',
          })),
          { reliable: true }
        );
        // Don't update currentSessionId yet — wait for agent's response with correct session
        return;
      }
      sessionState.currentSessionId = msg.sessionId;
      if (msg.projectName) setCurrentProject(msg.projectName);
      sessionState.viewingSessionId = null;
      fetchProjectTree();
    }

    // Context switched (project change from voice)
    else if (msg.type === 'context_switched') {
      setCurrentProject(msg.projectName);
      sessionState.currentSessionId = msg.sessionId;
      // Don't clear conversation during active voice — messages are still being generated.
      // Only clear if NOT connected (text-initiated switch) or switching to session with history.
      if (!state.connected) {
        if (msg.sessionId) {
          try {
            const res = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${msg.sessionId}`);
            if (res.ok) {
              const session = await res.json();
              if (session.messages && session.messages.length > 0) {
                $('#conversation').innerHTML = '';
                for (const m of session.messages) {
                  if (m.role === 'tool') continue;
                  addMessage(m.role === 'user' ? 'user' : 'assistant', m.text);
                }
              }
            }
          } catch {}
        } else {
          $('#conversation').innerHTML = '';
        }
      }
      fetchProjectTree();
      updateSessionBar();
      logEvent('agent', `Context switched: ${msg.projectName}/${msg.sessionId || 'new'}`);
    }

  } catch (e) { console.warn('Failed to parse data message:', e); }
});

// --- Sidebar tabs ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector('#tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'files') fetchFileTree();
  });
});

// --- File browser ---
const TEXT_EXTENSIONS = ['.md','.txt','.json','.ts','.js','.css','.html','.yaml','.yml','.csv','.xml','.env','.log','.mjs','.jsx','.tsx'];

async function fetchFileTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '<div style="color:#666;font-size:0.8rem;padding:0.5rem">Loading...</div>';
  try {
    const project = sessionState.currentProject || '_global';
    const res = await fetch('/api/projects/' + project + '/files');
    if (!res.ok) throw new Error('Failed to load files');
    const files = await res.json();
    tree.innerHTML = '';
    renderFileTree(tree, files, '');
  } catch (err) {
    tree.innerHTML = '<div style="color:#ef4444;font-size:0.8rem;padding:0.5rem">' + err.message + '</div>';
  }
}

function renderFileTree(container, entries, pathPrefix) {
  for (const entry of entries) {
    const fullPath = pathPrefix ? pathPrefix + '/' + entry.name : entry.name;
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    item.style.paddingLeft = ((fullPath.split('/').length - 1) * 0.8 + 0.4) + 'rem';

    if (entry.type === 'directory') {
      item.classList.add('file-tree-dir');
      item.textContent = '📁 ' + entry.name + '/';
      let expanded = true;
      item.addEventListener('click', () => {
        expanded = !expanded;
        const children = item.nextElementSibling;
        if (children && children.classList.contains('file-tree-children')) {
          children.style.display = expanded ? '' : 'none';
        }
        item.textContent = (expanded ? '📂 ' : '📁 ') + entry.name + '/';
      });
      container.appendChild(item);
      if (entry.children && entry.children.length > 0) {
        const childContainer = document.createElement('div');
        childContainer.className = 'file-tree-children';
        renderFileTree(childContainer, entry.children, fullPath);
        container.appendChild(childContainer);
      }
    } else {
      item.textContent = '📄 ' + entry.name;
      item.addEventListener('click', () => openFile(fullPath, entry.name));
      container.appendChild(item);
    }
  }
}

function openFile(filePath, fileName) {
  const project = sessionState.currentProject || '_global';
  const ext = '.' + fileName.split('.').pop().toLowerCase();
  if (TEXT_EXTENSIONS.includes(ext)) {
    showFileViewer(project, filePath);
  } else {
    window.open('/api/projects/' + project + '/files/' + filePath, '_blank');
  }
}

async function showFileViewer(project, filePath) {
  try {
    const res = await fetch('/api/projects/' + project + '/files/' + filePath);
    if (!res.ok) throw new Error('Failed to load file');
    const content = await res.text();
    $('#conversation').style.display = 'none';
    $('#text-input-bar').style.display = 'none';
    const viewer = $('#file-viewer');
    viewer.style.display = 'flex';
    viewer.style.flexDirection = 'column';
    viewer.style.flex = '1';
    viewer.style.minHeight = '0';
    $('#file-viewer-path').textContent = '📄 ' + filePath;
    $('#file-viewer-content').textContent = content;
    sessionState.viewingFile = filePath;
    updateSessionBar();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

$('#file-viewer-back').addEventListener('click', () => {
  $('#file-viewer').style.display = 'none';
  $('#conversation').style.display = '';
  $('#text-input-bar').style.display = '';
  sessionState.viewingFile = null;
  updateSessionBar();
});

$('#file-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const project = sessionState.currentProject || '_global';
  const errorEl = $('#file-upload-error');
  errorEl.textContent = '';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/projects/' + project + '/files', { method: 'POST', body: formData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Upload failed');
    }
    fetchFileTree();
  } catch (err) {
    errorEl.textContent = 'Upload failed: ' + err.message;
  }
  e.target.value = '';
});

// --- New project form ---
$('#new-project-btn').addEventListener('click', () => {
  $('#modal-new-project').style.display = 'flex';
  $('#new-project-name').value = '';
  $('#new-project-desc').value = '';
  $('#new-project-error').textContent = '';
  $('#new-project-name').focus();
});

$('#new-project-cancel').addEventListener('click', () => {
  $('#modal-new-project').style.display = 'none';
});

async function submitNewProject() {
  const name = $('#new-project-name').value.trim();
  if (!name) return;
  const description = $('#new-project-desc').value.trim() || undefined;
  const errorEl = $('#new-project-error');
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errorEl.textContent = data.error || 'Failed to create project';
      return;
    }
    $('#modal-new-project').style.display = 'none';
    fetchProjectTree();
  } catch (err) {
    $('#new-project-error').textContent = err.message;
  }
}

$('#new-project-submit').addEventListener('click', submitNewProject);

$('#new-project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitNewProject(); }
  if (e.key === 'Escape') { $('#modal-new-project').style.display = 'none'; }
});

$('#new-project-desc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitNewProject(); }
  if (e.key === 'Escape') { $('#modal-new-project').style.display = 'none'; }
});

// --- Delete project modal ---
let pendingDeleteProject = null;

function showDeleteProjectModal(projectName) {
  pendingDeleteProject = projectName;
  const display = getProjectDisplayName(projectName);
  $('#modal-project-name').textContent = display !== projectName ? `${display} (${projectName})` : projectName;
  $('#modal-project-input').value = '';
  $('#modal-project-input').placeholder = projectName;
  $('#modal-project-error').textContent = '';
  $('#modal-project-delete').disabled = true;
  $('#modal-delete-project').style.display = 'flex';
  $('#modal-project-input').focus();
}

$('#modal-project-input').addEventListener('input', (e) => {
  $('#modal-project-delete').disabled = e.target.value !== pendingDeleteProject;
});

$('#modal-project-delete').addEventListener('click', async () => {
  if (!pendingDeleteProject) return;
  const errorEl = $('#modal-project-error');
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/projects/' + pendingDeleteProject, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmName: pendingDeleteProject }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
    $('#modal-delete-project').style.display = 'none';
    if (sessionState.currentProject === pendingDeleteProject) {
      setCurrentProject('_global');
      sessionState.currentSessionId = null;
    }
    fetchProjectTree();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

$('#modal-project-cancel').addEventListener('click', () => {
  $('#modal-delete-project').style.display = 'none';
});

$('#modal-project-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#modal-project-delete').disabled) {
    e.preventDefault();
    $('#modal-project-delete').click();
  }
  if (e.key === 'Escape') { $('#modal-delete-project').style.display = 'none'; }
});

// Global Esc handler for all modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#modal-new-project').style.display = 'none';
    $('#modal-delete-project').style.display = 'none';
    $('#modal-delete-session').style.display = 'none';
  }
});

// --- Delete session modal ---
let pendingDeleteSession = null;

function showDeleteSessionModal(projectName, sessionId) {
  pendingDeleteSession = { projectName, sessionId };
  $('#modal-session-error').textContent = '';
  $('#modal-delete-session').style.display = 'flex';
}

$('#modal-session-delete').addEventListener('click', async () => {
  if (!pendingDeleteSession) return;
  const { projectName, sessionId } = pendingDeleteSession;
  const errorEl = $('#modal-session-error');
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/projects/' + projectName + '/sessions/' + sessionId, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
    $('#modal-delete-session').style.display = 'none';
    if (sessionState.currentSessionId === sessionId) {
      sessionState.currentSessionId = null;
      $('#conversation').innerHTML = '';
    }
    fetchProjectTree();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

$('#modal-session-cancel').addEventListener('click', () => {
  $('#modal-delete-session').style.display = 'none';
});

// --- Sidebar resize ---
const resizeHandle = $('#sidebar-resize');
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const appMinWidth = 300;
  const maxWidth = window.innerWidth - appMinWidth;
  const newWidth = Math.max(200, Math.min(e.clientX, maxWidth));
  $('#sidebar').style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  localStorage.setItem('sidebarWidth', $('#sidebar').style.width);
});

const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) $('#sidebar').style.width = savedWidth;

// --- Breadcrumb click ---
$('#breadcrumb-project').addEventListener('click', () => {
  document.querySelector('.sidebar-tab[data-tab="chats"]').click();
  if (window.innerWidth <= 640) {
    $('#sidebar').classList.add('open');
    $('#sidebar-overlay').classList.add('open');
  }
});
