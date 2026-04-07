# Session History — Design Spec

## Goal

Add conversation session history to the voice assistant. Users can browse past sessions, read transcripts, search across sessions, and resume previous conversations with full Claude context.

## Data Model

### Storage

JSON files on filesystem in `data/sessions/` (Docker volume for persistence).

### index.json

Array of session metadata for fast listing:

```json
[
  {
    "sessionId": "abc-123",
    "claudeSessionId": "claude-xyz",
    "created": "2026-04-07T14:30:00Z",
    "updated": "2026-04-07T14:45:00Z",
    "preview": "Pomoz mi s deploy na prod",
    "messageCount": 12
  }
]
```

### {sessionId}.json

Full transcript per session:

```json
{
  "sessionId": "abc-123",
  "claudeSessionId": "claude-xyz",
  "created": "2026-04-07T14:30:00Z",
  "messages": [
    { "role": "user", "text": "Pomoz mi s deploy", "timestamp": "2026-04-07T14:30:12Z" },
    { "role": "assistant", "text": "Jasně, nejdřív zkontroluju...", "timestamp": "2026-04-07T14:30:15Z" },
    { "role": "tool", "name": "Bash", "input": "git status", "output": "...", "timestamp": "2026-04-07T14:30:16Z" }
  ]
}
```

- `sessionId` — our ID, generated on session creation (e.g. `crypto.randomUUID()`)
- `claudeSessionId` — ID from Claude Agent SDK, captured from first response, used for `resume`
- Tool calls stored but hidden by default in UI (expandable detail)

## Backend API

### New endpoints in token-server.ts

| Endpoint | Description |
|---|---|
| `GET /api/sessions` | List sessions from index.json. Optional `?q=search` for fulltext |
| `GET /api/sessions/:id` | Full transcript of one session |

### Fulltext search

- Case-insensitive substring match across `messages[].text` in all session files
- Brute-force iteration — sufficient for tens of sessions
- Returns matching sessions sorted by newest first

### Token endpoint change

- `GET /api/token?session=abc-123` — agent resumes this session
- `GET /api/token` (no session) — new session

No new POST/PUT endpoints — the agent writes session files internally during conversation.

## Agent Flow

### New session

1. Web calls `GET /api/token` (no session param)
2. Agent creates `AgentSDKHandler` with `sessionId = null`, `claudeSessionId = null`
3. After first Claude response, `claudeSessionId` is captured
4. Agent creates `{sessionId}.json` in `data/sessions/`, adds entry to `index.json`
5. Each turn appends messages to session file and updates index

### Resume session

1. Web calls `GET /api/token?session=abc-123`
2. Agent loads `{sessionId}.json`, retrieves `claudeSessionId`
3. `AgentSDKHandler` initializes with existing `claudeSessionId` → `resume: claudeSessionId` passed to query()
4. Claude has full context from previous conversation
5. New messages append to existing session file

### Session info broadcast

- Agent sends `{type: 'session_info', sessionId: 'abc-123'}` via LiveKit data channel after session creation/load
- Web client stores `currentSessionId` and highlights in sidebar

### Disconnect

- Session file persists (no deletion)
- `claudeSessionId` stays in file for future resume
- Web releases LiveKit connection, sidebar remains visible

## Frontend

### Layout — Desktop (>640px)

Two-column flex layout:
- **Sidebar** (280px): search input, "New Session" button, scrollable session list
- **Chat** (flex: 1): existing layout unchanged (header, mic, conversation, controls, latency/cost bars, event log)

Active session highlighted in blue.

### Layout — Mobile (<=640px)

- Sidebar hidden by default
- Hamburger icon (☰) in header
- Click → sidebar slides in as fixed overlay over dimmed chat
- Click session or ✕ → sidebar closes

### Session list item

- Preview text (first user message, max ~50 chars)
- Date/time
- Message count

### Read-only transcript view

When clicking a non-active session in sidebar:
- Mic section and controls hidden
- Session title + metadata shown at top (name, date, message count, status)
- Full transcript displayed in conversation area with timestamps per message
- Purple highlight on selected session in sidebar (vs blue for active)
- **Resume button** (purple) in header area
- Info bar at bottom: "Read-only transcript · Click Resume to continue conversation"

### Resume flow

1. User clicks Resume button
2. Web calls `GET /api/token?session={sessionId}`
3. Connects to LiveKit, agent loads session and resumes Claude context
4. UI switches from read-only to live chat (mic, controls appear)
5. Session highlight changes from purple to blue (active)

### Search

- Input at top of sidebar with 300ms debounce
- Calls `GET /api/sessions?q=...`
- Results replace normal session list
- Empty query → back to full list

## Docker Changes

New volume for session data persistence:

```yaml
volumes:
  - session-data:/app/data/sessions
```

## Files to modify

- `src/token-server.ts` — add `/api/sessions` and `/api/sessions/:id` endpoints, pass session param to agent
- `src/agent.ts` — session lifecycle (create/load/save), broadcast session_info via data channel
- `src/plugins/agent-sdk-handler.ts` — accept initial `claudeSessionId` for resume on construction
- `web/index.html` — sidebar HTML structure, hamburger button, responsive meta
- `web/style.css` — sidebar styles, responsive breakpoints, read-only view, mobile overlay
- `web/app.js` — sidebar logic, session list fetch, search, read-only view, resume flow
- `docker-compose.yml` — add session-data volume
- New: `src/session-store.ts` — session CRUD (read/write JSON files, index management, search)
