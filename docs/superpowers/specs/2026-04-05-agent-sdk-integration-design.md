# Claude Agent SDK Integration — Design Spec

Replace the custom `ToolLLM` plugin with a new `AgentLLM` plugin that wraps Claude Agent SDK. This gives the voice assistant full Claude Code capabilities (bash, file editing, code search, etc.) while keeping the LiveKit voice pipeline unchanged.

## Goals

- Full Claude Code agent capabilities via voice
- Persistent session for low latency (no subprocess spawn per turn)
- Custom permission control via `canUseTool` callback
- Tool use visibility in web UI event log
- Authentication via Claude subscription (OAuth)

## Architecture

```
Mikrofon → STT (Deepgram) → AgentLLM → TTS (OpenAI)
                                ↕
                    Claude Agent SDK session (persistent)
                                ↕
                    Bash, Read, Write, Edit, Glob, Grep
```

The pipeline remains identical — only the LLM plugin changes. `AgentLLM` implements the same `llm.LLM` interface as the existing `ToolLLM`.

## AgentLLM Plugin

### Class structure

```
AgentLLM extends llm.LLM
  - #session: persistent Claude Agent SDK v2 session (lazy-init)
  - #onEvent: EventSender callback (sends events to web client)
  - #canUseTool: permission callback (allow/deny + log)
  - chat() → AgentLLMStream

AgentLLMStream extends llm.LLMStream
  - run(): sends user text to session, streams response tokens to pipeline
```

### Session lifecycle

- Session created lazily on first `chat()` call via `unstable_v2_createSession()`
- Session persists across the entire conversation (no respawn per turn)
- If session dies (error, crash), a new one is created on the next `chat()` call
- Session config:
  - `model`: configurable (default `claude-sonnet-4-6`)
  - `permissionMode`: `'default'`
  - `canUseTool`: custom callback
  - System prompt: TTS-friendly formatting rules (same as current)

### Streaming flow

1. `chat()` called by LiveKit pipeline with `chatCtx` (conversation history)
2. Extract latest user message text from `chatCtx`
3. `session.send(userText)`
4. Iterate `session.stream()`:
   - `stream_event` with `content_block_delta` / `text_delta` → `this.queue.put()` → flows to TTS
   - Tool use events → logged via `onEvent` to web client
5. When stream completes, `queue` closes automatically

### Permission control (`canUseTool`)

Called for every tool invocation. Responsibilities:
- **Decision**: allow or deny the action (e.g., deny destructive commands)
- **Logging**: send event to web client via `onEvent` so user sees what Claude is doing

Example rules:
- Allow: `Bash`, `Read`, `Glob`, `Grep`, `Write`, `Edit`
- Deny: commands containing `rm -rf`, `sudo`, or accessing sensitive paths
- Log all invocations to web UI event log

### Authentication

Claude Agent SDK supports Claude subscription via OAuth (`claude login`). No API key needed if user is logged in. Falls back to `ANTHROPIC_API_KEY` env var if set.

## Changes

### New files

- `src/plugins/agent-llm.ts` — AgentLLM + AgentLLMStream

### Modified files

- `src/agent.ts` — import `AgentLLM` instead of `ToolLLM`, pass to pipeline
- `web/app.js` — handle new `tool_use` event type in event log

### Deleted files

- `src/plugins/tool-llm.ts` — replaced by `agent-llm.ts`
- `src/plugins/tools.ts` — no longer needed (Claude has bash)

### Unchanged

- LiveKit pipeline (VAD, STT, TTS)
- Web UI (conversation history, latency, cost tracking)
- Token server, Docker setup, LiveKit config

## Dependencies

- `@anthropic-ai/claude-agent-sdk` (npm install)

## Risks

- **Agent SDK v2 session API is unstable/alpha** — may change or break. Mitigation: fallback to `query()` per turn if session fails.
- **Latency** — even with persistent session, Claude Code agent loop (tool calls, bash execution) adds time. Voice responses will be slower when Claude uses tools vs. direct text response.
- **Output length** — Claude may produce long responses (file contents, bash output). TTS will read everything. Mitigation: system prompt instructs concise spoken responses.
