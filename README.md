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

- Docker
- API keys: [Deepgram](https://console.deepgram.com), [OpenAI](https://platform.openai.com)
- Claude subscription (for Agent SDK)

### Setup

```bash
# Clone
git clone https://github.com/jiridudekusy/no-realtimeapi-poc.git
cd no-realtimeapi-poc

# Configure
cp .env.example .env
# Edit .env — add your Deepgram and OpenAI API keys

# Build and start everything
docker compose up -d --build

# Login to Claude (once — persisted in Docker volume)
docker compose exec agent claude login

# Follow logs
docker compose logs agent -f
```

Open **http://localhost:3001**, click **Connect**, allow microphone, and start talking.

## Web UI features

- Conversation history with live STT transcription
- Mic toggle with visual indicator
- Latency breakdown per response (STT / LLM / TTS)
- Cumulative cost tracking (tokens, characters, estimated USD)
- Server event log (state changes, tool calls, metrics, errors)
- Copy log to clipboard

## Project structure

```
├── Dockerfile                # Agent worker container
├── docker-compose.yml        # LiveKit server + agent
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
4. Response sentences are fed back via `agentSession.say()`
5. LiveKit TTS converts to audio and sends via WebRTC

Session persistence via `resume: sessionId` — Claude remembers the full conversation.

## Claude Agent SDK integration

- **v1 `query()` API** — each turn = clean query call with `abortController`
- **`resume: sessionId`** — conversation history persists across turns
- **`query.interrupt()`** — barge-in support (Ctrl+C equivalent)
- **`canUseTool` callback** — logs and controls tool permissions
- **`--strict-mcp-config`** — skips loading user's MCP servers for faster startup

## License

MIT
