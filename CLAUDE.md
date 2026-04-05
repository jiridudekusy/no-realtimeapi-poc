# no-realtimeapi-poc

Low-latency voice assistant built on LiveKit (open-source). Pluggable STT/TTS pipeline with Claude Agent SDK.

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
- LiveKit pipeline: VAD → STT → (no LLM) → TTS. LLM step handled outside pipeline.
- `src/agent.ts` — LiveKit agent, listens for UserInputTranscribed, sends to AgentSDKHandler, calls session.say() for TTS
- `src/token-server.ts` — Express server (JWT tokens + static files from web/)
- `src/plugins/agent-sdk-handler.ts` — Wraps Claude Agent SDK v1 query() API with resume, interrupt, sentence splitting
- `web/` — Vanilla HTML/JS client with livekit-client from CDN

## Claude Agent SDK notes
- v1 query() API — each turn = new query() call, clean lifecycle
- resume: sessionId — maintains conversation history across turns
- extraArgs: { 'strict-mcp-config': null } — skips loading user MCP servers
- permissionMode: 'default' + canUseTool callback — allows tools but blocks dangerous patterns
- query.interrupt() — Ctrl+C equivalent for barge-in
