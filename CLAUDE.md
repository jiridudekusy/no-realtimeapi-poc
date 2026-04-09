# no-realtimeapi-poc

Low-latency voice assistant built on LiveKit (open-source). Pluggable STT/TTS pipeline with Claude Agent SDK.

**Keep CLAUDE.md and README.md up to date** — when architecture, commands, config, or behavior changes, update both files as part of the commit.

## Release flow
When releasing a new version ("vydej verzi", "release"):
1. Bump version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Update `README.md` if architecture/commands/behavior changed
4. Commit, tag (`vX.Y.Z`), push
5. Create GitHub release via `gh release create` with release notes from CHANGELOG

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
- `src/token-server.ts` — Express server: JWT tokens, static files from web/, session API, POST /api/chat (SSE), POST /api/projects/:name/chat (sync JSON)
- `src/plugins/agent-sdk-handler.ts` — Wraps Claude Agent SDK v1 query() API with resume, interrupt, sentence splitting, LLM latency timing, onSessionIdCaptured/onAssistantMessage/onToolCall callbacks
- `src/session-store.ts` — Session persistence (JSON files), CRUD, fulltext search, session naming
- `src/project-store.ts` — Project CRUD, workspace directory management
- `src/project-context.ts` — Tracks current project/session, navigation stack, loads project config (CLAUDE.md + .mcp.json)
- `src/mcp/navigation-server.ts` — In-process MCP server with tools: list/create/switch project, list/switch/new chat, go_back, go_home
- `src/navigation-handler.ts` — Logic for each navigation command (called by both agent and token-server)
- `src/workspace-init.ts` — Workspace initialization, session migration from old format
- `web/` — Vanilla HTML/JS client with livekit-client from CDN

## Sync chat API (programmatic)
- POST /api/projects/:name/chat — synchronous JSON request/response
- Request: `{ text, sessionId? }` → Response: `{ text, sessionId, projectName }`
- Without sessionId creates new session, with sessionId resumes existing
- Shares sessions with voice and SSE chat (same claudeSessionId)
- For programmatic use (Claude Code, scripts, curl) — no SSE, waits for full response

## Dual input: voice and text
- **Voice**: Connect → LiveKit pipeline (VAD → STT → Claude → TTS). Agent responds with speech.
- **Text**: POST /api/chat (SSE). Token server has its own AgentSDKHandler. Agent responds with text only, no TTS.
- Both share the same session via `claudeSessionId` — seamless switching between voice and text.
- When switching from text to voice (Connect), web client sends `session_init` so agent loads the text session's Claude context.
- Transcript coalescing: 2s debounce after last transcript (partial or final) before sending to Claude. Prevents breath pauses from splitting one thought into multiple queries.

## Projects
- Project = directory in `/app/workspace/` with sessions/, .mcp.json, CLAUDE.md, .claude/skills/
- `_global` = home space (no project), always exists
- Project has `name` (slug for directory, a-zA-Z0-9 and hyphens only) and `displayName` (user-entered, can have diacritics/special chars)
- Slugify transliterates diacritics (č→c, ř→r) via NFD normalization before stripping
- `workspace` Docker volume at `/app/workspace`
- Navigation via in-process MCP server (createSdkMcpServer from Agent SDK)
- Navigation tools: list_projects, create_project, switch_project (info only), list_chats, switch_chat, new_chat, go_back, go_home
- Context switch: closes Claude handler, creates new one with target project's cwd, MCP servers, CLAUDE.md
- System prompt layered: global CLAUDE.md + project CLAUDE.md
- MCP servers layered: global .mcp.json + project .mcp.json
- Navigation stack for go_back (push on switch, pop on back)
- Voice lock file prevents text writes to chat active in voice (HTTP 409)
- Voice connection is persistent — projects/chats switch under it without reconnecting
- API: /api/projects (list, create, get, update), /api/projects/:name/sessions/* (scoped)
- /api/sessions backward compat → redirects to _global

## Session History
- Sessions stored per-project in workspace/{project}/sessions/ (index.json + per-session files)
- Lazy session creation — sessions only created on first user message, not on agent startup
- `claudeSessionId` persisted immediately on capture (not after response completes) to avoid race conditions
- API: GET /api/projects/:name/sessions(?q=search), GET/PATCH, POST generate-name
- Resume uses Claude Agent SDK `resume: claudeSessionId` for full context
- Sidebar UI with fulltext search (desktop: always visible, mobile: hamburger overlay)
- Read-only transcript view with Resume button for past sessions
- Editable session names with ✨ AI auto-generation via Claude Agent SDK
- Empty sessions (0 messages) filtered from sidebar listing

## Web UI
- Tree sidebar: projects as collapsible groups, chats nested inside, Home (\_global) at top
- Sidebar tabs: Chats (project tree) / Files (file browser)
- Resizable sidebar: drag right edge, min 200px, chat pane min 300px, width persisted in localStorage
- Breadcrumb session bar: `📁 project / chat name ✨ date · count` — project clickable
- File browser: tree view, text files open inline, binary in new tab, upload button
- File viewer: read-only `<pre>` in main area with Back to chat button
- Project creation via inline form in sidebar
- Project deletion: modal with name confirmation (type name to delete)
- Session deletion: modal with yes/no confirmation
- Compact toolbar: mic button + Connect/Disconnect/Hold + latency/cost metrics in one row
- Server Events log: collapsed by default, scrollable when expanded
- Text input: always available, works without voice connection
- Auto-disconnect voice when switching sessions in sidebar
- User speech bubbles coalesced (finalized only when agent responds)
- Error handling: all API operations show visible error messages (modals, inline, toast)

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
- `workspace` Docker volume for projects, sessions, and files (replaces old session-data)
- Dev compose mounts `./src` and `./web` — restart (not rebuild) for code changes

## Tailscale HTTPS (for remote/mobile access)
- `tailscale serve --bg 3001` — HTTPS proxy for web client
- `tailscale serve --bg --https 7880 7880` — HTTPS/WSS proxy for LiveKit
- Web client auto-detects ws/wss based on page protocol
- livekit.yaml `node_ip` must match Tailscale IP for WebRTC ICE candidates
