# no-realtimeapi-poc

> **Proof of Concept** — This is an experiment exploring how to build a real-time voice assistant without OpenAI's Realtime API. Not production-ready, not a final solution — just a PoC showing it's possible and what the tradeoffs look like.

Low-latency voice assistant built on [LiveKit](https://livekit.io/) (open-source WebRTC) with [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) as the brain.

## How it works

```
Browser (WebRTC) ──► LiveKit Server (SFU) ──► Agent Worker (Node.js)
                 ◄──                       ◄──

Voice:  Silero VAD → Deepgram STT → Claude Agent SDK → OpenAI TTS
Text:   HTTP POST /api/chat → Claude Agent SDK → SSE response
Sync:   HTTP POST /api/projects/:name/chat → Claude Agent SDK → JSON response
```

- **STT**: Deepgram Nova-3 (streaming, Czech) — configurable
- **LLM**: Claude Agent SDK (default), OpenAI, or OpenRouter — configurable per-project via `pipeline.json`
- **TTS**: OpenAI tts-1 (Nova voice, multilingual) — configurable
- **VAD**: Silero (voice activity detection) — configurable

All processors are configurable via `workspace/pipeline.json` (global) and `workspace/{project}/pipeline.json` (per-project override). LiveKit handles WebRTC transport, VAD, STT, and TTS. The LLM step runs outside the LiveKit pipeline — STT transcripts go to the configured LLM backend, responses come back via `session.say()`.

**Dual input**: voice and text share the same session. Say something, then type a follow-up — Claude remembers both. Text input works without voice connection (no Connect needed).

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

Open **http://localhost:3001** — you can start typing immediately (no connection needed) or click **Connect** for voice mode.

To check logs:

```bash
docker compose -f docker-compose.prod.yml logs agent -f
```

## Apple Containers (macOS)

Native alternative to Docker on macOS — each container runs in its own lightweight micro-VM via Virtualization.framework. Unlike Docker (which shares a single Linux kernel across all containers), Apple Containers provide hardware-level isolation per container, making it a more secure option.

### Prerequisites

- Mac with Apple Silicon, macOS 26 (Tahoe) or later
- [Apple Containers installed and configured](https://www.notion.so/33c5769baa568168b918ec98c009cacb) — including DNS setup (`container-dns` domain)
- [Tailscale](https://tailscale.com/) — ports must be bound to `127.0.0.1` to avoid conflicts

### 1. Configure

```bash
cp .env.example .env
# Edit .env and fill in your API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY)
```

### 2. Start LiveKit

```bash
container run --detach --name livekit \
  --publish 127.0.0.1:7880:7880 \
  --publish 127.0.0.1:7881:7881 \
  -v ./livekit.yaml.template:/etc/livekit.yaml.template:ro \
  --entrypoint sh \
  livekit/livekit-server \
  -c 'IP=${LIVEKIT_NODE_IP:-127.0.0.1} && sed s/NODE_IP_PLACEHOLDER/$IP/ /etc/livekit.yaml.template > /tmp/livekit.yaml && exec /livekit-server --config=/tmp/livekit.yaml --dev'
```

### 3. Start the agent

```bash
container run --detach --name agent \
  --publish 127.0.0.1:3001:3001 \
  --env-file .env \
  -e LIVEKIT_URL=ws://livekit:7880 \
  ghcr.io/jiridudekusy/no-realtimeapi-poc:latest
```

### 4. Login to Claude

```bash
container exec -it agent claude login
```

### 5. Use it

Open **http://localhost:3001**

### Stopping

```bash
container stop agent && container rm agent
container stop livekit && container rm livekit
```

### Troubleshooting

- **"Address already in use"** — Tailscale conflict. Use `127.0.0.1:PORT:PORT` format in `--publish`.
- **"flag provided but not defined: -c"** — Use `--entrypoint sh` separately, then `-c '...'` as an argument.
- **Shell args with spaces** — Use `--flag=value` instead of `--flag value` inside entrypoint commands (Apple Container parses arguments differently than Docker).
- **Container DNS not resolving** — Make sure `container-dns` domain is configured. See [setup guide](https://www.notion.so/33c5769baa568168b918ec98c009cacb).

## Remote access via Tailscale

To use the voice assistant from a phone, tablet, or another computer on your network, you need HTTPS (browsers require it for microphone access on non-localhost origins).

### Prerequisites

- [Tailscale](https://tailscale.com/) installed on your machine and the remote device
- Both devices on the same Tailnet
- [HTTPS certificates enabled](https://tailscale.com/kb/1153/enabling-https) for your Tailnet (in Tailscale admin console under DNS → Enable HTTPS)

### 1. Set your Tailscale hostname (optional)

```bash
sudo tailscale set --hostname=voice-assistant
```

Provision an HTTPS certificate for your hostname:

```bash
tailscale cert voice-assistant.your-tailnet.ts.net
```

This is instant — Tailscale issues certificates automatically.

### 2. Set LiveKit node IP to your Tailscale IP

LiveKit needs to advertise your Tailscale IP so remote devices can establish WebRTC connections.

```bash
# Find your Tailscale IP
tailscale ip -4
# e.g. 100.77.2.54

# Add it to .env
echo "LIVEKIT_NODE_IP=100.77.2.54" >> .env

# Restart to apply
docker compose -f docker-compose.prod.yml restart livekit
```

If you skip this, LiveKit defaults to `127.0.0.1` which only works from localhost.

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

## Projects

Projects let you organize conversations into separate workspaces. Each project has its own chat history, files, MCP servers, Claude instructions, and skills.

### Use case: hands-free on the go

You're driving to a meeting. With your earbuds in, you start a conversation:

> **You:** "What projects do I have?"
>
> **Assistant:** "You have three projects: website-redesign, mobile-app, and quarterly-report."
>
> **You:** "Switch to quarterly report."
>
> **Assistant:** "Quarterly report has two recent chats: 'Revenue analysis' from yesterday with eight messages, and 'Executive summary draft' from three days ago with twelve messages. Want to continue one of these or start a new chat?"
>
> **You:** "Continue the revenue analysis."
>
> **Assistant:** "Switched. Last time we were looking at Q1 numbers. The revenue was up twelve percent. What would you like to focus on?"
>
> **You:** "Search the web for our competitor's latest earnings."

The assistant searches, summarizes results. Then you switch:

> **You:** "Go back. Switch to website-redesign, new chat."
>
> **Assistant:** "New chat in website-redesign. How can I help?"
>
> **You:** "Based on the brand guide in this project, suggest three color palettes."

The assistant reads the brand guide file from the project directory and suggests palettes.

Later at your desk, you open the web UI, see all your projects in the sidebar, browse the files the assistant created, review chat transcripts, and pick up where you left off — by text this time.

### How it works

- **Project = directory** in `/app/workspace/` with sessions, files, `.mcp.json`, `CLAUDE.md`, skills
- **Navigation via voice tools**: Claude has built-in tools to list/create/switch projects and chats
- **Voice stays connected** — projects and chats switch underneath without reconnecting
- **Per-project configuration**: each project can have its own MCP servers (`.mcp.json`), system prompt (`CLAUDE.md`), and skills (`.claude/skills/`)
- **Layered config**: global `.mcp.json` + project `.mcp.json` merge; same for `CLAUDE.md`
- **Navigation stack**: `go_back` returns to the previous project/chat (like browser history)

### Project UI

- **Tree sidebar**: projects as collapsible groups with nested chats
- **Chats/Files tabs**: switch between chat list and file browser
- **File browser**: tree view, text files open inline, binary in new tab, upload button
- **Breadcrumb**: `📁 project / chat name` in the header — project is clickable
- **Resizable sidebar**: drag the right edge, width persisted
- **Project creation**: `+ New Project` button or voice command
- **Deletion**: projects (with name confirmation) and individual chats

## Web UI features

- **Dual input**: type text or use voice — both share the same conversation context
- **Session history**: sidebar with all past conversations, fulltext search, read-only transcript view
- **Session resume**: click Resume on any past session to continue with full Claude context
- **Session naming**: editable names with ✨ AI auto-generation from conversation content
- **Voice controls**: mic toggle, Connect/Disconnect, LLM Hold (buffer transcripts)
- **Latency tracking**: STT / LLM / TTS breakdown in toolbar
- **Cost tracking**: tokens and estimated USD
- **Server event log**: state changes, tool calls, metrics, errors (collapsible)
- **Responsive**: sidebar as hamburger overlay on mobile (≤640px)
- **Light/dark theme**: toggle or follows system preference

## Project structure

```
├── Dockerfile                # Agent worker container (non-root, Claude Code CLI)
├── docker-compose.yml        # Dev: LiveKit server + agent (source mounted)
├── docker-compose.prod.yml   # Prod: pulls pre-built image
├── livekit.yaml.template     # LiveKit config template
├── src/
│   ├── agent.ts              # LiveKit agent — voice only (STT → Claude → TTS)
│   ├── token-server.ts       # Express: JWT tokens, static files, session/project API, text chat
│   ├── session-store.ts      # Session persistence (JSON files, index, search)
│   ├── project-store.ts      # Project CRUD and workspace directory management
│   ├── project-context.ts    # Current project/session tracking, navigation stack
│   ├── navigation-handler.ts # Logic for project/chat navigation commands
│   ├── workspace-init.ts     # Workspace initialization and session migration
│   ├── mcp/
│   │   └── navigation-server.ts  # In-process MCP server for navigation tools
│   └── plugins/
│       └── agent-sdk-handler.ts  # Claude Agent SDK wrapper (query + resume + callbacks)
├── web/
│   ├── index.html            # Web client (tree sidebar + chat + toolbar + modals)
│   ├── style.css             # Full-viewport layout, responsive, light/dark
│   ├── app.js                # LiveKit client, text chat, project/session management
│   └── favicon.png           # App icon
├── workspace/                # Project workspaces (Docker volume)
│   ├── projects.json         # Project index
│   ├── _global/              # Home space (sessions, .mcp.json, CLAUDE.md)
│   └── {project-name}/      # Project directories
└── .env.example              # Environment template
```

## Architecture

The key insight: LiveKit pipeline handles only **VAD + STT + TTS** (no LLM plugin). The LLM step is handled outside the pipeline:

### Voice path
1. `UserInputTranscribed` events fire with STT text
2. Transcripts coalesced (2s debounce — partials reset timer) into one message
3. Text sent to Claude Agent SDK via `query()` API
4. Claude responds (possibly using tools — bash, files, curl)
5. Response buffered (200ms coalesce, 1.5s max) and fed via `agentSession.say()`
6. LiveKit TTS converts to audio and sends via WebRTC

### Text path
1. User types message → `POST /api/chat` with SSE streaming
2. Token server creates `AgentSDKHandler`, sends to Claude via `query()`
3. Sentences stream back as SSE events, displayed in chat
4. No LiveKit connection needed

### Sync API path
1. External client sends `POST /api/projects/:name/chat` with JSON body
2. Token server creates `AgentSDKHandler`, sends to Claude via `query()`
3. Waits for full response, returns as JSON `{ text, sessionId, projectName }`
4. For programmatic use (Claude Code, scripts, automation)

All three paths share sessions via `claudeSessionId` — switching between voice, text, and sync API preserves full conversation context.

When Claude needs to use a tool, it first announces what it will do (e.g., "Podívám se na počasí"), which gets flushed to TTS immediately. The user hears feedback while the tool executes.

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
- All LLM calls go through Agent SDK (included in Claude subscription)

## Docker notes

- LiveKit health check ensures agent starts only after server is ready
- Agent has `restart: unless-stopped` for auto-recovery
- Claude auth persisted in `claude-auth` Docker volume (login once)
- Workspace persisted in `workspace` Docker volume (projects, sessions, files)
- Source dirs mounted as volumes for live editing (`src/`, `web/`) — restart, don't rebuild
- LiveKit ports bound to `127.0.0.1` to avoid conflicts with Tailscale serve
- VAD `minSilenceDuration: 1.5s` for natural Czech speech
- `shutdownProcessTimeout: 3s` for faster job cleanup between sessions

## Release notes

See [CHANGELOG.md](CHANGELOG.md) for what's new in each version.

## License

MIT
