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
- `docker compose logs agent -f` — follow agent logs
- `docker compose build agent` — rebuild after code changes
- Web client: http://localhost:3001

## Environment
- `.env` — API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY, LIVEKIT_*)
- Token server default port: 3001
- LiveKit in Docker needs `use_external_ip: false` + `node_ip: 127.0.0.1` in livekit.yaml
- Deepgram TTS does NOT support Czech — use OpenAI TTS
- Deepgram STT with `language: 'multi'` is unreliable for Czech — use `language: 'cs'`

## Architecture
- LiveKit pipeline: VAD → STT → (no LLM) → TTS. LLM step handled outside pipeline via say().
- `src/agent.ts` — LiveKit agent, listens for UserInputTranscribed, sends to AgentSDKHandler, calls session.say() for TTS
- `src/token-server.ts` — Express server (JWT tokens + static files from web/)
- `src/plugins/agent-sdk-handler.ts` — Wraps Claude Agent SDK v1 query() API with resume, interrupt, sentence splitting
- `web/` — Vanilla HTML/JS client with livekit-client from CDN
- Smart TTS buffering: 200ms coalesce window (max 1.5s), immediate flush on tool calls

## Claude Agent SDK notes
- v1 query() API — each turn = new query() call, clean lifecycle
- resume: sessionId — maintains conversation history across turns
- extraArgs: { 'strict-mcp-config': null } — skips loading user MCP servers
- System prompt instructs Claude to announce actions before tool calls
- query.interrupt() — Ctrl+C equivalent for barge-in

## Permissions
- permissionMode: 'default' — tools go through permission chain
- allowedTools: Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, ToolSearch — auto-approved (step 4)
- Bash NOT in allowedTools — goes through canUseTool callback (step 5)
- canUseTool blocks dangerous patterns: rm -rf, sudo, mkfs, dd if=, >/dev/, chmod 777, curl|bash, wget|bash
- Container runs as non-root user `node` (required for Claude Code permissions)

## Docker / LiveKit notes
- LiveKit health check in docker-compose — agent waits for healthy server before starting
- Each Connect creates unique room (`voice-{timestamp}`) — prevents stale room issues on reconnect
- LiveKit ports bound to 127.0.0.1 — use Tailscale serve for remote HTTPS access
- shutdownProcessTimeout: 3s for faster job cleanup between sessions
- Agent has `restart: unless-stopped` for auto-recovery
- Claude auth persisted in `claude-auth` Docker volume

## Tailscale HTTPS (for remote/mobile access)
- `tailscale serve --bg 3001` — HTTPS proxy for web client
- `tailscale serve --bg --https 7880 7880` — HTTPS/WSS proxy for LiveKit
- Web client auto-detects ws/wss based on page protocol
- livekit.yaml `node_ip` must match Tailscale IP for WebRTC ICE candidates
