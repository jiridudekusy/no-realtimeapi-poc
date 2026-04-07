# no-realtimeapi-poc

Low-latency voice assistant built on LiveKit (open-source). Pluggable STT/TTS pipeline with Claude Agent SDK.

**Keep CLAUDE.md and README.md up to date** — when architecture, commands, config, or behavior changes, update both files as part of the commit.

## Stack
- TypeScript, Node.js (ESM), Express v5
- LiveKit Agents SDK v1.x (`@livekit/agents`) — VAD, STT, TTS only (no LLM plugin)
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — v1 query() API with resume for session persistence
- Deepgram STT (nova-3, Czech), OpenAI TTS (tts-1, nova voice), Silero VAD

## Commands
- `docker compose up -d` — start LiveKit server + agent (all Dockerized)
- `docker compose exec agent claude login` — login to Claude (once, persisted in volume)
- `docker compose restart agent` — restart after code changes (no rebuild needed)
- `docker compose build agent` — rebuild only when Dockerfile/package.json/tsconfig change
- `docker compose logs agent -f` — follow agent logs
- Web client: http://localhost:3001

## Environment
- `.env` — API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY, LIVEKIT_*)
- Token server default port: 3001
- LiveKit in Docker needs `use_external_ip: false` + `node_ip: 127.0.0.1` in livekit.yaml
- Deepgram TTS does NOT support Czech — use OpenAI TTS
- Deepgram STT with `language: 'multi'` is unreliable for Czech — use `language: 'cs'`

## Architecture
- LiveKit pipeline: VAD → STT → (no LLM) → TTS. LLM step handled outside pipeline via say().
- `src/agent.ts` — LiveKit agent, voice-only: listens for UserInputTranscribed, coalesces transcripts (2s debounce), sends to AgentSDKHandler, calls session.say() for TTS
- `src/token-server.ts` — Express server: JWT tokens, static files from web/, session API, POST /api/chat for text input (SSE streaming)
- `src/plugins/agent-sdk-handler.ts` — Wraps Claude Agent SDK v1 query() API with resume, interrupt, sentence splitting, LLM latency timing, onSessionIdCaptured/onAssistantMessage/onToolCall callbacks
- `src/session-store.ts` — Session persistence (JSON files in data/sessions/), CRUD, fulltext search, session naming
- `web/` — Vanilla HTML/JS client with livekit-client from CDN

## Dual input: voice and text
- **Voice**: Connect → LiveKit pipeline (VAD → STT → Claude → TTS). Agent responds with speech.
- **Text**: POST /api/chat (SSE). Token server has its own AgentSDKHandler. Agent responds with text only, no TTS.
- Both share the same session via `claudeSessionId` — seamless switching between voice and text.
- When switching from text to voice (Connect), web client sends `session_init` so agent loads the text session's Claude context.
- Transcript coalescing: 2s debounce after last transcript (partial or final) before sending to Claude. Prevents breath pauses from splitting one thought into multiple queries.

## Session History
- Sessions stored as JSON files in `data/sessions/` (index.json + per-session files)
- Lazy session creation — sessions only created on first user message, not on agent startup
- `claudeSessionId` persisted immediately on capture (not after response completes) to avoid race conditions
- API: GET /api/sessions(?q=search), GET /api/sessions/:id, PATCH /api/sessions/:id (rename), POST /api/sessions/:id/generate-name
- Resume uses Claude Agent SDK `resume: claudeSessionId` for full context
- Sidebar UI with fulltext search (desktop: always visible, mobile: hamburger overlay)
- Read-only transcript view with Resume button for past sessions
- Editable session names with ✨ AI auto-generation via Claude Agent SDK
- `session-data` Docker volume persists transcripts in `/app/data/sessions`
- Empty sessions (0 messages) filtered from sidebar listing

## Web UI
- Full-viewport layout: sidebar scrolls independently, conversation fills available space, no page scroll
- Compact toolbar: mic button + Connect/Disconnect/Hold + latency/cost metrics in one row
- Session bar: editable name + ✨ generate + date/count meta + Resume (read-only mode)
- Server Events log: collapsed by default, scrollable when expanded
- Text input: always available, works without voice connection
- Auto-disconnect voice when switching sessions in sidebar
- User speech bubbles coalesced (finalized only when agent responds)

## Claude Agent SDK notes
- v1 query() API — each turn = new query() call, clean lifecycle
- resume: sessionId — maintains conversation history across turns
- extraArgs: { 'strict-mcp-config': null } — skips loading user MCP servers
- System prompt instructs Claude to announce actions before tool calls
- query.interrupt() — Ctrl+C equivalent for barge-in
- All LLM calls go through Agent SDK (subscription-based, no per-token cost) — never use Anthropic API directly

## Permissions
- permissionMode: 'default' — tools go through permission chain
- allowedTools: Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, ToolSearch — auto-approved (step 4)
- Bash NOT in allowedTools — goes through canUseTool callback (step 5)
- canUseTool blocks dangerous patterns: rm -rf, sudo, mkfs, dd if=, >/dev/, chmod 777, curl|bash, wget|bash
- Container runs as non-root user `node` (required for Claude Code permissions)

## Latency tracking
- STT: computed as time from first partial transcript to final transcript (Deepgram streaming durationMs is always 0)
- LLM: time from query start to first sentence (tracked in agent-sdk-handler)
- TTS: from LiveKit MetricsCollected event
- Displayed in toolbar metrics bar only (not per-bubble — metrics arrive asynchronously)
- Reset when new user turn starts (not when agent speaks)

## Docker / LiveKit notes
- LiveKit health check in docker-compose — agent waits for healthy server before starting
- Each Connect creates unique room (`voice-{timestamp}`) — prevents stale room issues on reconnect
- LiveKit ports bound to 127.0.0.1 — use Tailscale serve for remote HTTPS access
- VAD minSilenceDuration: 1.5s for Czech speech patterns
- shutdownProcessTimeout: 3s for faster job cleanup between sessions
- Agent has `restart: unless-stopped` for auto-recovery
- Claude auth persisted in `claude-auth` Docker volume
- `session-data` Docker volume for conversation transcripts
- Dev compose mounts `./src` and `./web` — restart (not rebuild) for code changes

## Tailscale HTTPS (for remote/mobile access)
- `tailscale serve --bg 3001` — HTTPS proxy for web client
- `tailscale serve --bg --https 7880 7880` — HTTPS/WSS proxy for LiveKit
- Web client auto-detects ws/wss based on page protocol
- livekit.yaml `node_ip` must match Tailscale IP for WebRTC ICE candidates
