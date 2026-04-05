# no-realtimeapi-poc

Low-latency voice assistant built on [LiveKit](https://livekit.io/) (open-source WebRTC). A pluggable STT/LLM/TTS pipeline that's **~90x cheaper** than OpenAI Realtime API.

## How it works

```
Browser (WebRTC) ──► LiveKit Server (SFU) ──► Agent Worker (Node.js)
                 ◄──                       ◄──

Agent pipeline: Silero VAD → Deepgram STT → LLM (with tools) → OpenAI TTS
```

- **STT**: Deepgram Nova-3 (streaming, Czech)
- **LLM**: GPT-4o-mini with custom tool calling middleware
- **TTS**: OpenAI tts-1 (Nova voice, multilingual)
- **VAD**: Silero (voice activity detection)
- **Tools**: Current time, weather (Open-Meteo)

All components are pluggable — swap any provider by changing one line.

## Cost comparison (1 hour of conversation)

| | This project | OpenAI Realtime API |
|---|---|---|
| **Cost/hour** | ~$0.65 | ~$58 |
| Latency | ~2-3s | ~0.5-1s |
| Flexibility | Any STT/LLM/TTS | OpenAI only |

## Quick start

### Prerequisites

- Node.js 20+
- Docker
- API keys: [Deepgram](https://console.deepgram.com), [OpenAI](https://platform.openai.com)

### Setup

```bash
# Clone
git clone https://github.com/jiridudekusy/no-realtimeapi-poc.git
cd no-realtimeapi-poc

# Install
npm install

# Configure
cp .env.example .env
# Edit .env — add your Deepgram and OpenAI API keys

# Start LiveKit server
docker compose up -d

# Start agent + web client
npm run dev
```

Open **http://localhost:3001**, click **Connect**, allow microphone, and start talking.

## Web UI features

- Conversation history with live STT transcription
- Mic toggle with visual indicator
- Latency breakdown per response (STT / LLM / TTS)
- Cumulative cost tracking (tokens, characters, estimated USD)
- Server event log (state changes, tool calls, metrics, errors)

## Project structure

```
├── docker-compose.yml        # LiveKit server
├── livekit.yaml              # LiveKit config
├── src/
│   ├── agent.ts              # Voice pipeline agent
│   ├── token-server.ts       # Express: JWT tokens + static files
│   └── plugins/
│       ├── tool-llm.ts       # Custom LLM with tool calling loop
│       └── tools.ts          # Tool definitions (time, weather)
├── web/
│   ├── index.html            # Web client
│   ├── style.css
│   └── app.js                # LiveKit client + UI logic
└── .env.example              # Environment template
```

## Swapping components

Edit `src/agent.ts`:

```typescript
// Change STT
stt: new deepgram.STT({ model: 'nova-3', language: 'cs' }),
// or: new openai.STT({ model: 'whisper-1' }),

// Change LLM
llm: new ToolLLM({ model: 'gpt-4o-mini' }),
// or: new openai.LLM({ model: 'gpt-4o' }),

// Change TTS
tts: new openai.TTS({ model: 'tts-1', voice: 'nova' }),
// or: new deepgram.TTS({ model: 'aura-asteria-en' }),  // English only
```

## Adding tools

Edit `src/plugins/tools.ts` to add tool definitions and executors. The custom `ToolLLM` handles the tool calling loop automatically — when the LLM returns a tool call, it executes it and feeds the result back before streaming the final response.

## License

MIT
