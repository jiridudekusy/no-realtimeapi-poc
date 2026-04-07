# no-realtimeapi-poc

> **Proof of Concept** — This is an experiment exploring how to build a real-time voice assistant without OpenAI's Realtime API. Not production-ready, not a final solution — just a PoC showing it's possible and what the tradeoffs look like.

Low-latency voice assistant built on [LiveKit](https://livekit.io/) (open-source WebRTC) with [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) as the brain.

## How it works

```
Browser (WebRTC) ──► LiveKit Server (SFU) ──► Agent Worker (Node.js)
                 ◄──                       ◄──

Pipeline: Silero VAD → Deepgram STT → Claude Agent SDK → OpenAI TTS
```

- **STT**: Deepgram Nova-3 (streaming, Czech)
- **LLM**: Claude via Agent SDK (full agent capabilities — bash, file editing, internet access)
- **TTS**: OpenAI tts-1 (Nova voice, multilingual)
- **VAD**: Silero (voice activity detection)

LiveKit handles WebRTC transport, VAD, STT, and TTS. The LLM step runs outside the LiveKit pipeline — STT transcripts go to Claude Agent SDK, responses come back via `session.say()`.

## Quick start

### Prerequisites

- Docker and Docker Compose
- API keys: [Deepgram](https://console.deepgram.com) (STT), [OpenAI](https://platform.openai.com) (TTS)
- Claude subscription — the agent uses [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) which authenticates via `claude login`

### 1. Configure

```bash
git clone https://github.com/jiridudekusy/no-realtimeapi-poc.git
cd no-realtimeapi-poc
cp .env.example .env
```

Edit `.env` and fill in your API keys:

```env
DEEPGRAM_API_KEY=your-deepgram-key
OPENAI_API_KEY=your-openai-key
```

### 2. Start

Using the pre-built image (recommended):

```bash
docker compose -f docker-compose.prod.yml up -d
```

Or build from source:

```bash
docker compose up -d --build
```

### 3. Login to Claude

This only needs to be done once — credentials are persisted in a Docker volume.

```bash
# For pre-built image:
docker compose -f docker-compose.prod.yml exec agent claude login

# For source build:
docker compose exec agent claude login
```

Follow the prompts to authenticate with your Claude subscription.

### 4. Use it

Open **http://localhost:3001**, click **Connect**, allow microphone, and start talking.

To check logs:

```bash
docker compose -f docker-compose.prod.yml logs agent -f
```

## Remote access via Tailscale

To use the voice assistant from a phone, tablet, or another computer on your network, you need HTTPS (browsers require it for microphone access on non-localhost origins).

### Prerequisites

- [Tailscale](https://tailscale.com/) installed on your machine and the remote device
- Both devices on the same Tailnet

### 1. Set your Tailscale hostname (optional)

```bash
sudo tailscale set --hostname=voice-assistant
```

### 2. Find your Tailscale IP

```bash
tailscale ip -4
# e.g. 100.77.2.54
```

### 3. Configure LiveKit to advertise your Tailscale IP

Add to your `.env`:

```env
LIVEKIT_NODE_IP=100.77.2.54
```

Then restart LiveKit:

```bash
docker compose -f docker-compose.prod.yml restart livekit
```

### 4. Expose ports via Tailscale serve

```bash
# Web client (HTTPS on port 443)
tailscale serve --bg 3001

# LiveKit WebSocket (WSS on port 7880)
tailscale serve --bg --https 7880 7880
```

### 5. Access from your device

Open `https://voice-assistant.your-tailnet.ts.net` in your browser. Click **Connect**, allow microphone, and talk.

The web client automatically detects HTTPS and uses `wss://` for the LiveKit connection.

> **Note:** `tailscale serve` does not persist across reboots. You need to re-run the serve commands after restarting your machine.

## Web UI features

- Conversation history with live STT transcription
- Mic toggle with visual indicator
- Latency breakdown per response (STT / LLM / TTS)
- Cumulative cost tracking (tokens, characters, estimated USD)
- Server event log (state changes, tool calls, metrics, errors) with copy button
- Connection error display in chat

## Project structure

```
├── Dockerfile                # Agent worker container (non-root, Claude Code CLI)
├── docker-compose.yml        # LiveKit server (with health check) + agent
├── livekit.yaml              # LiveKit config
├── src/
│   ├── agent.ts              # LiveKit agent — STT events → Claude → say()
│   ├── token-server.ts       # Express: JWT tokens + static files
│   └── plugins/
│       └── agent-sdk-handler.ts  # Claude Agent SDK wrapper (query API + resume)
├── web/
│   ├── index.html            # Web client
│   ├── style.css
│   └── app.js                # LiveKit client + UI logic
└── .env.example              # Environment template
```

## Architecture

The key insight: LiveKit pipeline handles only **VAD + STT + TTS** (no LLM plugin). The LLM step is handled outside the pipeline:

1. `UserInputTranscribed` event fires with STT text
2. Text is sent to Claude Agent SDK via `query()` API
3. Claude responds (possibly using tools — bash, files, curl)
4. Response text is buffered (200ms coalesce, 1.5s max) and fed via `agentSession.say()`
5. LiveKit TTS converts to audio and sends via WebRTC

When Claude needs to use a tool, it first announces what it will do (e.g., "Podívám se na počasí"), which gets flushed to TTS immediately on tool call. The user hears feedback while the tool executes.

Each Connect creates a unique room (`voice-{timestamp}`) for clean agent dispatch. Session persistence via `resume: sessionId` — Claude remembers the full conversation within a session.

## Security

- **Permission model**: `permissionMode: 'default'` with layered controls
- **Safe tools auto-approved**: Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, ToolSearch
- **Bash filtered**: Every Bash command goes through `canUseTool` callback
- **Blocked patterns**: `rm -rf`, `sudo`, `mkfs`, `dd if=`, `>/dev/`, `chmod 777`, `curl|bash`, `wget|bash`
- **Container isolation**: Agent runs in Docker as non-root user `node`

## Claude Agent SDK integration

- **v1 `query()` API** — each turn = clean query call with `abortController`
- **`resume: sessionId`** — conversation history persists across turns
- **`query.interrupt()`** — barge-in support (Ctrl+C equivalent)
- **`--strict-mcp-config`** — skips loading user's MCP servers for faster startup

## Docker notes

- LiveKit health check ensures agent starts only after server is ready
- Agent has `restart: unless-stopped` for auto-recovery
- Claude auth persisted in `claude-auth` Docker volume (login once)
- Source dirs mounted as volumes for live editing (`src/`, `web/`)
- LiveKit ports bound to `127.0.0.1` to avoid conflicts with Tailscale serve
- `shutdownProcessTimeout: 3s` for faster job cleanup between sessions

## License

MIT
