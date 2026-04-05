# Realtime Voice API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a low-latency voice assistant using LiveKit (self-hosted WebRTC SFU) with pluggable STT/LLM/TTS pipeline, web client with conversation history, and latency measurement.

**Architecture:** LiveKit Server (Docker) handles WebRTC transport. A Node.js Agent Worker connects as a participant and runs the voice pipeline: Silero VAD → Deepgram STT → OpenAI LLM → Deepgram TTS. A vanilla HTML/JS web client connects via `livekit-client` SDK. A token endpoint on the agent server handles LiveKit auth.

**Tech Stack:** TypeScript, `@livekit/agents` v1.x, `@livekit/agents-plugin-deepgram`, `@livekit/agents-plugin-silero`, `@livekit/agents-plugin-openai`, `livekit-server-sdk`, `livekit-client`, Express, Docker.

---

## File Structure

```
realtimeApi/
├── docker-compose.yml          # LiveKit server
├── livekit.yaml                # LiveKit server config
├── package.json
├── tsconfig.json
├── .env.example                # Template for env vars
├── .gitignore
├── src/
│   ├── agent.ts                # Voice pipeline agent (defineAgent + entry)
│   └── token-server.ts         # Express server: token endpoint + static files
├── web/
│   ├── index.html              # Web client UI
│   ├── style.css               # Styles
│   └── app.js                  # Client-side JS (livekit-client)
└── docs/
```

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Initialize project and install dependencies**

```bash
cd /Users/jdk/work/incubator/realtimeApi
npm init -y
npm install @livekit/agents @livekit/agents-plugin-deepgram @livekit/agents-plugin-silero @livekit/agents-plugin-openai livekit-server-sdk express dotenv
npm install -D typescript @types/node @types/express
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Update package.json scripts and type**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "agent": "node dist/agent.js dev",
    "token-server": "node dist/token-server.js"
  }
}
```

- [ ] **Step 4: Create .env.example**

```env
# LiveKit (self-hosted, you pick these values)
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# Deepgram (https://console.deepgram.com)
DEEPGRAM_API_KEY=your-deepgram-api-key

# OpenAI (https://platform.openai.com)
OPENAI_API_KEY=your-openai-api-key
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
.superpowers/
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example .gitignore
git commit -m "feat: project setup with LiveKit agents dependencies"
```

---

### Task 2: LiveKit Server (Docker)

**Files:**
- Create: `livekit.yaml`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create livekit.yaml**

```yaml
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50060
  use_external_ip: true

keys:
  devkey: secret
```

- [ ] **Step 2: Create docker-compose.yml**

```yaml
services:
  livekit:
    image: livekit/livekit-server
    command: --config /etc/livekit.yaml --dev
    ports:
      - "7880:7880"
      - "7881:7881"
      - "50000-50060:50000-50060/udp"
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
```

- [ ] **Step 3: Test LiveKit server starts**

```bash
docker compose up -d
curl http://localhost:7880
```

Expected: server responds (HTTP 200 or similar). Logs show `starting in development mode`.

- [ ] **Step 4: Commit**

```bash
git add livekit.yaml docker-compose.yml
git commit -m "feat: LiveKit server Docker setup"
```

---

### Task 3: Token Server

**Files:**
- Create: `src/token-server.ts`

- [ ] **Step 1: Create token-server.ts**

```typescript
import 'dotenv/config';
import express from 'express';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..', 'web');

app.use(express.static(webDir));

app.get('/api/token', async (req, res) => {
  const room = (req.query.room as string) || 'voice-room';
  const identity = (req.query.identity as string) || `user-${Date.now()}`;

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity, ttl: '6h' },
  );

  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  };

  at.addGrant(grant);
  const token = await at.toJwt();
  res.json({ token });
});

const PORT = parseInt(process.env.TOKEN_SERVER_PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`Token server running at http://localhost:${PORT}`);
  console.log(`Web client at http://localhost:${PORT}/index.html`);
});
```

- [ ] **Step 2: Build and verify it starts**

```bash
npm run build
cp .env.example .env  # user fills in real keys
node dist/token-server.js
```

Expected: `Token server running at http://localhost:3000`

Test token endpoint:
```bash
curl "http://localhost:3000/api/token?room=test&identity=user1"
```

Expected: JSON with `{ "token": "eyJ..." }`

- [ ] **Step 3: Commit**

```bash
git add src/token-server.ts
git commit -m "feat: token server with Express + static file serving"
```

---

### Task 4: Voice Agent

**Files:**
- Create: `src/agent.ts`

- [ ] **Step 1: Create agent.ts**

```typescript
import 'dotenv/config';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as silero from '@livekit/agents-plugin-silero';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        'You are a helpful voice assistant. Respond concisely. You speak Czech and English — respond in the language the user speaks.',
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'multi',
      }),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
      }),
      tts: new deepgram.TTS({
        model: 'aura-asteria-en',
      }),
    });

    session.on('agent_state_changed', (state) => {
      console.log(`Agent state: ${state}`);
    });

    session.on('user_input_transcribed', (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);
    });

    session.on('metrics_collected', (ev) => {
      console.log('Metrics:', JSON.stringify(ev));
    });

    await session.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();

    session.generateReply({
      instructions: 'Greet the user briefly and ask how you can help.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
```

- [ ] **Step 2: Build and verify it starts**

Make sure LiveKit server is running (`docker compose up -d`), then:

```bash
npm run build
npm run agent
```

Expected: Agent connects to LiveKit, logs show `worker registered` or similar.

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: voice agent with Deepgram STT/TTS, OpenAI LLM, Silero VAD"
```

---

### Task 5: Web Client

**Files:**
- Create: `web/index.html`
- Create: `web/style.css`
- Create: `web/app.js`

- [ ] **Step 1: Create web/index.html**

```html
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Assistant</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <header>
      <h1>Voice Assistant</h1>
      <span id="status" class="status disconnected">● Disconnected</span>
    </header>

    <div id="mic-section">
      <button id="mic-btn" class="mic-btn" disabled>🎙️</button>
      <div id="mic-label">Connect to start</div>
    </div>

    <div id="conversation"></div>

    <div id="controls">
      <button id="connect-btn">Connect</button>
      <button id="disconnect-btn" disabled>Disconnect</button>
    </div>

    <div id="latency-bar">
      <span>STT <strong id="lat-stt">—</strong></span>
      <span>LLM <strong id="lat-llm">—</strong></span>
      <span>TTS <strong id="lat-tts">—</strong></span>
      <span>Total <strong id="lat-total">—</strong></span>
    </div>
  </div>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create web/style.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  display: flex;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
}

#app {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

header h1 { font-size: 1.2rem; }

.status { font-size: 0.85rem; }
.status.disconnected { color: #888; }
.status.connected { color: #10b981; }
.status.listening { color: #3b82f6; }
.status.speaking { color: #a855f7; }

#mic-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1.5rem 0;
}

.mic-btn {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 2px solid #333;
  background: #1a1a1a;
  font-size: 2rem;
  cursor: pointer;
  transition: all 0.2s;
}

.mic-btn:disabled { opacity: 0.4; cursor: default; }
.mic-btn.active { border-color: #ef4444; background: rgba(239,68,68,0.15); }

#mic-label { font-size: 0.8rem; color: #888; }

#conversation {
  flex: 1;
  min-height: 300px;
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: rgba(255,255,255,0.03);
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.08);
}

.msg {
  max-width: 85%;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.9rem;
  line-height: 1.4;
}

.msg.user {
  align-self: flex-start;
  background: rgba(37,99,235,0.2);
  color: #93c5fd;
  border-bottom-left-radius: 2px;
}

.msg.user.partial { border: 1px dashed rgba(59,130,246,0.3); opacity: 0.7; }

.msg.assistant {
  align-self: flex-end;
  background: rgba(255,255,255,0.08);
  color: #ccc;
  border-bottom-right-radius: 2px;
}

.msg .meta {
  font-size: 0.7rem;
  color: #666;
  margin-bottom: 0.3rem;
}

.msg .latency { color: #888; font-size: 0.7rem; margin-top: 0.3rem; }

#controls {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
}

#controls button {
  padding: 0.5rem 1.5rem;
  border: none;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
}

#connect-btn { background: #2563eb; color: white; }
#connect-btn:disabled { opacity: 0.4; cursor: default; }
#disconnect-btn { background: rgba(239,68,68,0.2); color: #f87171; }
#disconnect-btn:disabled { opacity: 0.4; cursor: default; }

#latency-bar {
  display: flex;
  gap: 1rem;
  justify-content: center;
  font-size: 0.75rem;
  color: #666;
}

#latency-bar strong { color: #888; }
```

- [ ] **Step 3: Create web/app.js**

```javascript
import {
  Room,
  RoomEvent,
  Track,
  ParticipantEvent,
  TranscriptionSegment,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs';

const $ = (sel) => document.querySelector(sel);
const room = new Room({ adaptiveStream: true, dynacast: true });

const state = {
  connected: false,
  currentUserMsg: null,   // DOM element for partial STT
  currentAssistMsg: null, // DOM element for streaming assistant reply
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
// LiveKit agents publish transcriptions as data messages on the track.
// The agent SDK sends TranscriptionReceived events for both user STT and agent speech.

room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
  const isAgent = participant?.identity?.startsWith('agent');

  for (const seg of segments) {
    if (isAgent) {
      // Agent (assistant) transcription
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
      // User transcription (STT)
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
```

- [ ] **Step 4: Build, start all services, and test end-to-end**

Terminal 1:
```bash
docker compose up -d
```

Terminal 2:
```bash
npm run build && npm run agent
```

Terminal 3:
```bash
npm run build && npm run token-server
```

Open `http://localhost:3000` in browser, click Connect, allow microphone, speak. Expected:
- STT partial results appear as user bubbles
- Agent responds with voice + text in assistant bubbles
- Audio plays through browser

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "feat: web client with conversation history and latency display"
```

---

### Task 6: Latency Measurement

**Files:**
- Modify: `src/agent.ts`
- Modify: `web/app.js`

- [ ] **Step 1: Add metrics forwarding in agent.ts**

Add to the `entry` function, after `session.on('metrics_collected', ...)`:

```typescript
    session.on('metrics_collected', (ev) => {
      console.log('Metrics:', JSON.stringify(ev));
      // Forward metrics to the room as a data message so the web client can display them
      const data = new TextEncoder().encode(JSON.stringify({ type: 'metrics', ...ev }));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    });
```

Remove the previous `session.on('metrics_collected', ...)` line and replace with this one.

- [ ] **Step 2: Add metrics display in web/app.js**

Add after the transcription event handler:

```javascript
// --- Metrics ---

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
```

- [ ] **Step 3: Test latency display**

Rebuild, restart agent and token-server. Open browser, speak. Expected: latency bar at the bottom updates with STT/LLM/TTS timing after each interaction.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts web/app.js
git commit -m "feat: latency metrics forwarded to web client"
```

---

### Task 7: Documentation and Final Polish

**Files:**
- Modify: `package.json` (add start script)

- [ ] **Step 1: Add combined start script to package.json**

Add to scripts:

```json
{
  "start": "npm run build && concurrently \"npm run agent\" \"npm run token-server\"",
  "dev": "npm run build && concurrently --names agent,web --prefix-colors blue,green \"npm run agent\" \"npm run token-server\""
}
```

Install concurrently:
```bash
npm install -D concurrently
```

- [ ] **Step 2: Test full startup flow**

```bash
docker compose up -d
npm run dev
```

Expected: Both agent and token-server start. Open `http://localhost:3000`, full voice conversation works.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: combined dev script with concurrently"
```
