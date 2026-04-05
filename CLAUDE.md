# no-realtimeapi-poc

Low-latency voice assistant built on LiveKit (open-source). Pluggable STT/LLM/TTS pipeline.

## Stack
- TypeScript, Node.js (ESM), Express v5
- LiveKit Agents SDK v1.x (`@livekit/agents`)
- Deepgram STT, OpenAI TTS (tts-1), OpenAI LLM (gpt-4o-mini), Silero VAD
- Custom ToolLLM plugin for tool calling (bypasses LiveKit's built-in tools)

## Commands
- `docker compose up -d` — start LiveKit server
- `npm run build` — compile TypeScript
- `npm run dev` — build + run agent and token server (concurrently)
- `npm run agent` — run agent only
- `npm run token-server` — run token server only
- Web client: http://localhost:3001

## Environment
- Token server default port: 3001 (configurable via TOKEN_SERVER_PORT env var)
- LiveKit in Docker on macOS needs `use_external_ip: false` + `node_ip: 127.0.0.1` in livekit.yaml
- LiveKit Agents v1.x API: `defineAgent({ prewarm, entry })`, `voice.Agent`, `voice.AgentSession`
- Event names use `voice.AgentSessionEventTypes.AgentStateChanged` (not string literals)
- Deepgram TTS does NOT support Czech — use OpenAI TTS
- Deepgram STT with `language: 'multi'` is unreliable for Czech — use `language: 'cs'`

## Architecture
- `src/agent.ts` — LiveKit agent entry point with voice pipeline
- `src/token-server.ts` — Express server (JWT tokens + static files from web/)
- `src/plugins/tool-llm.ts` — Custom LLM wrapping OpenAI with tool calling loop
- `src/plugins/tools.ts` — Tool definitions and executors (time, weather)
- `web/` — Vanilla HTML/JS client with livekit-client from CDN
