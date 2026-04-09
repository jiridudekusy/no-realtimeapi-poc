# Pluggable Pipeline — Design Spec

## Goal

Make all processors (VAD, STT, TTS, LLM) configurable and swappable via `pipeline.json`. Support multiple LLM backends including non-Claude providers (OpenAI, OpenRouter). Non-Claude backends get navigation tools via function calling.

## Configuration

### pipeline.json

**`workspace/pipeline.json`** — global defaults:

```json
{
  "vad": { "provider": "silero", "minSilenceDuration": 1.5 },
  "stt": { "provider": "deepgram", "model": "nova-3", "language": "cs" },
  "tts": { "provider": "openai", "model": "tts-1", "voice": "nova" },
  "llm": { "provider": "agent-sdk", "model": "claude-sonnet-4-6" }
}
```

**`workspace/{project}/pipeline.json`** — per-project override (only what differs):

```json
{
  "llm": { "provider": "openrouter", "model": "openai/gpt-4o" }
}
```

Merge strategy: deep merge, project overrides workspace values.

If neither file exists, hardcoded defaults are used (current behavior).

### Secrets in .env

```
# Claude (Agent SDK) — auth via `claude login`, no env key needed
# OpenAI
OPENAI_API_KEY=sk-...
# OpenRouter
OPENROUTER_API_KEY=sk-or-...
# Future: Codex OAuth
# OPENAI_CODEX_REFRESH_TOKEN=... (or file path)
```

API keys only in `.env`, never in pipeline.json.

### Provider options

**VAD**: `silero` (only option for now)
- `minSilenceDuration`: number (seconds, default 1.5)

**STT**: `deepgram`
- `model`: string (default "nova-3")
- `language`: string (default "cs")

**TTS**: `openai`
- `model`: string (default "tts-1")
- `voice`: string (default "nova")

**LLM**: `agent-sdk` | `openai` | `openrouter`
- `model`: string (required)
- Provider-specific: see LLM section below

## LLM Handler Interface

```typescript
interface LLMHandler {
  sendAndStream(
    text: string,
    onSentence: (sentence: string) => void,
    onToolCall?: () => void,
  ): Promise<void>;

  interrupt(): void;
  close(): void;
  readonly sessionId: string | null;
}
```

All three LLM providers implement this interface. Agent code and token server interact only through `LLMHandler` — no provider-specific logic leaks outside.

### AgentSDKHandler (existing)

- Provider: `agent-sdk`
- Tools: full set (Bash, Read, Write, Glob, Grep, WebFetch, WebSearch, ToolSearch) + navigation
- Session: Claude-side persistence via `resume: sessionId`
- Auth: `claude login` (persisted in claude-auth volume)
- No changes needed — already implements the interface

### OpenAIChatHandler (new)

- Providers: `openai` and `openrouter` (same code, different base URL + API key)
- Tools: navigation tools only (list_projects, create_project, switch_project, list_chats, switch_chat, new_chat, go_back, go_home, rename_chat) via OpenAI function calling
- Session: local message history from session-store, sent as `messages[]` on each turn
- Auth: API key from `.env` (future: Codex OAuth refresh token)
- Streaming: SSE via OpenAI streaming API, sentence splitting same as AgentSDKHandler

Base URLs:
- `openai`: `https://api.openai.com/v1`
- `openrouter`: `https://openrouter.ai/api/v1`

## Navigation Tools as Functions

Navigation tools are defined as OpenAI function definitions:

```typescript
const navigationFunctions = [
  {
    name: "list_projects",
    description: "List all available projects with descriptions.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "create_project",
    description: "Create a new project.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional description" }
      },
      required: ["name"]
    }
  },
  // ... switch_project, list_chats, switch_chat, new_chat, go_back, go_home, rename_chat
];
```

When the model calls a function → we execute it via existing `navigation-handler.ts` → return result as function message → model continues.

The same NavigationCommand type and handler logic is reused — only the transport changes (MCP for Agent SDK, function calling for OpenAI).

## Session Persistence for Non-Claude Backends

Non-Claude backends don't have server-side session persistence. Instead:

1. On each turn, load messages from session-store
2. Build OpenAI `messages[]` array: system prompt + all previous user/assistant messages
3. Send full history with the new user message
4. Save assistant response to session-store as usual

The `claudeSessionId` field in session data is only used by Agent SDK. For OpenAI/OpenRouter, it stays null — session identity is the local session ID.

Future optimization: sliding window or summary for long conversations. Not in scope now.

## Factory Functions

```typescript
// src/plugins/llm-factory.ts
function createLLMHandler(
  config: PipelineConfig['llm'],
  opts: LLMHandlerOpts,
): LLMHandler {
  switch (config.provider) {
    case 'agent-sdk':
      return new AgentSDKHandler(opts);
    case 'openai':
      return new OpenAIChatHandler({
        ...opts,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY!,
        model: config.model,
      });
    case 'openrouter':
      return new OpenAIChatHandler({
        ...opts,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY!,
        model: config.model,
      });
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
```

Similarly for STT, TTS, VAD — but simpler since they're just LiveKit plugin constructors with config params.

## Pipeline Config Loader

```typescript
// src/pipeline-config.ts
interface PipelineConfig {
  vad: { provider: string; [key: string]: unknown };
  stt: { provider: string; [key: string]: unknown };
  tts: { provider: string; [key: string]: unknown };
  llm: { provider: string; model: string; [key: string]: unknown };
}

async function loadPipelineConfig(
  workspaceDir: string,
  projectName?: string,
): Promise<PipelineConfig> {
  // 1. Hardcoded defaults
  // 2. Deep merge workspace/pipeline.json
  // 3. Deep merge workspace/{project}/pipeline.json (if project specified)
  // Returns merged config
}
```

## Files to Change

| File | Change |
|------|--------|
| `src/pipeline-config.ts` | **New** — config loader, defaults, merge |
| `src/plugins/llm-factory.ts` | **New** — LLM handler factory |
| `src/plugins/openai-chat-handler.ts` | **New** — OpenAI/OpenRouter handler with function calling |
| `src/plugins/agent-sdk-handler.ts` | Extract `LLMHandler` interface, implement it explicitly |
| `src/plugins/nav-functions.ts` | **New** — navigation tools as OpenAI function definitions |
| `src/agent.ts` | Load pipeline config, use factories for VAD/STT/TTS/LLM |
| `src/token-server.ts` | Load pipeline config, use LLM factory for chat endpoints |
| `workspace/pipeline.json` | **New** — default config (created by workspace-init) |
| `package.json` | Add `openai` dependency (already present for TTS) |

## What Stays the Same

- Navigation handler logic (`navigation-handler.ts`) — unchanged
- Session store — unchanged
- Project store — unchanged
- Web UI — unchanged (doesn't care which LLM backend is used)
- Voice pipeline structure (VAD → STT → LLM → TTS) — unchanged
- SYSTEM_INSTRUCTIONS prompt — shared across all backends

## Out of Scope (Future)

- Codex OAuth flow (device auth + refresh token management)
- Non-navigation tools for OpenAI/OpenRouter backends (Bash, Read, Write via function calling)
- Additional STT providers (Whisper local)
- Additional TTS providers (local TTS)
- Additional VAD providers
- Sliding window / summary for long conversations
- UI for changing pipeline config
