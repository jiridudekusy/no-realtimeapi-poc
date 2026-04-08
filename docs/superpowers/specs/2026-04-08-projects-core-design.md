# Projects — Core Design Spec

## Goal

Add project workspaces to the voice assistant. Users can group conversations into projects, each with its own files, MCP servers, skills, and Claude context. Navigation between projects and chats is fully voice-driven (hands-free, e.g. while driving). GUI reflects context changes in real-time.

This is Spec 1 of 2. Covers: data model, navigation MCP server, context switching, backend signals. Spec 2 (future) covers: sidebar UI, file browser, upload, config editing.

## Data Model

### Workspace Directory

Mounted as Docker volume at `/app/workspace`:

```
/app/workspace/
  projects.json                    # project index
  _global/                         # home space (no project)
    sessions/
      index.json
      {sessionId}.json
    .mcp.json                      # global MCP servers
    CLAUDE.md                      # global system prompt
    .claude/skills/                # global skills
  website-redesign/                # project = subdirectory
    sessions/
      index.json
      {sessionId}.json
    .mcp.json                      # project MCP servers
    CLAUDE.md                      # project system prompt (merged with global)
    .claude/skills/                # project skills
    docs/                          # user files (inputs)
    output/                        # generated files (outputs)
    ...
  mobile-app/
    ...
```

### projects.json

```json
[
  {
    "name": "website-redesign",
    "description": "Company website redesign Q2 2026",
    "created": "2026-04-08T10:00:00Z"
  }
]
```

- `name` is unique, used as directory name (slugified)
- `description` is optional
- `_global` is reserved, not listed in projects.json

### Sessions

Sessions live inside each project's `sessions/` directory. Same format as current SessionData/SessionMeta (sessionId, claudeSessionId, name, messages, etc.). Each project has its own `SessionStore` instance.

The existing central `data/sessions/` is replaced — sessions migrate into `_global/sessions/` or project directories.

## Navigation MCP Server

In-process MCP server using `createSdkMcpServer` from Agent SDK. Provides tools for project and chat navigation. Available in every context (global and per-project).

### Tools

| Tool | Parameters | Action | Returns |
|---|---|---|---|
| `list_projects` | none | Read projects.json | List of projects with descriptions |
| `create_project` | `name`, `description?` | Create directory + add to index | Confirmation |
| `switch_project` | `projectName` | **Does NOT switch.** Reads target project info + recent chats | Project info + recent chat list for user to choose |
| `list_chats` | `count?`, `hoursAgo?` | List chats in current project | Filtered chat list |
| `switch_chat` | `projectName`, `chatId` | **Switches context.** Confirms with user first, then performs context switch | Confirmation + triggers context_switched event |
| `new_chat` | `projectName` | **Switches context.** Creates new chat in target project + switches | Confirmation + triggers context_switched event |
| `go_back` | none | Pop navigation stack, switch to previous context | Confirmation + triggers context_switched event |
| `go_home` | none | Switch to _global space + new or recent chat | Same as switch_project for _global |

### Navigation Flow

Typical voice interaction:

1. User: "Přepni se do projektu website-redesign"
2. Claude calls `switch_project("website-redesign")`
3. Tool returns: "Project website-redesign: Company website redesign Q2 2026. Recent chats: 1) Homepage layout discussion (2h ago), 2) Color palette brainstorm (yesterday). Want to continue one of these or start a new chat?"
4. Claude relays this to user (voice or text)
5. User: "Pokračuj v tom prvním"
6. Claude calls `switch_chat("website-redesign", "chat-id-123")`
7. Tool confirms with user, performs context switch
8. New Claude handler starts with project's cwd, MCP servers, CLAUDE.md, and resumed chat

Shortcuts — user can combine in one sentence:
- "Založ nový chat v projektu mobile-app" → `new_chat("mobile-app")` (with confirmation)
- "Pokračuj v posledním chatu v projektu X" → `switch_project` + `switch_chat` in sequence

### Confirmation

Before `switch_chat`, `new_chat`, `go_back`, `go_home` perform the actual switch, Claude must confirm with the user. The confirmation is handled by Claude's conversational flow (system prompt instructs it), not by the tool itself.

System prompt addition:
```
When switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation. Only call the switching tool after they agree.
```

## Initial Context

User does not always start in `_global`. They can start in any project/chat:

- **Voice (Connect)**: web client sends `session_init` with both `projectName` and `sessionId`. Agent initializes `ProjectContext` with that project, loads its `.mcp.json`, `CLAUDE.md`, and resumes the chat.
- **Text**: `/api/chat` receives `projectName` + `sessionId` in the body. Stateless — always knows which project/chat to use.
- **Fresh start (no context)**: defaults to `_global`, new chat.

This means the Connect flow changes: `session_init` message gains a `projectName` field. The agent uses it to set up the correct workspace from the start.

## Context Switch Mechanism

### What happens on switch_chat / new_chat

1. **Push to navigation stack**: save current `{projectName, sessionId}` 
2. **Close current Claude handler**: `claude.close()`
3. **Load target project config**:
   - `cwd` = `/app/workspace/{projectName}/` (or `_global/`)
   - MCP servers = navigation server + parse `.mcp.json` from project dir + `.mcp.json` from `_global/`
   - System prompt = read `CLAUDE.md` from `_global/` + `CLAUDE.md` from project dir (layered)
4. **Load or create session**: 
   - `switch_chat`: load session from project's `sessions/`, get `claudeSessionId` for resume
   - `new_chat`: create new session in project's `sessions/`
5. **Create new AgentSDKHandler** with loaded config
6. **Send context_switched event** to frontend: `{type: 'context_switched', projectName, sessionId}`
7. **First message in new context**: Claude greets or continues conversation

### Navigation Stack

Array of `{projectName: string | '_global', sessionId: string}`. Push on every switch, pop on `go_back`.

Stack is per voice-connection (agent) or per text-session (token-server). Not persisted — cleared on disconnect/page refresh.

### go_back

Pop last entry from stack. If stack is empty, return error "No previous context to return to."

## AgentSDKHandler Changes

New constructor options:
- `mcpServers` — already added in PoC (Record of MCP server configs)
- `additionalAllowedTools` — already added in PoC
- `cwd` — working directory for Claude Code (new)
- `systemPrompt` — override system prompt (new, currently hardcoded)

The `cwd` option maps to the Agent SDK's working directory configuration. The `systemPrompt` is composed by the caller from global + project CLAUDE.md files.

## Concurrency: Voice + Text

Voice (LiveKit agent) and text (HTTP `/api/chat`) are independent channels with separate contexts:

- **Voice** — agent process holds a `ProjectContext` for the duration of the LiveKit room. Navigation stack lives here.
- **Text** — each `/api/chat` request is stateless. `projectName` + `sessionId` come from the request body. No persistent server-side context.
- **Browsing** — GET requests (sessions, transcripts) are always allowed regardless of voice state.
- **Conflict prevention** — if a chat is currently active in voice, text writes to that same chat are rejected (HTTP 409). Writing to other chats in any project is fine.

This means:
- User can talk via voice in project A / chat X, while browsing project B in the browser
- User can send text messages to project B / chat Y from the browser simultaneously
- User cannot send text to project A / chat X while voice is active there

### ProjectContext (voice only)

```typescript
interface ProjectContext {
  projectName: string; // '_global' for home
  sessionStore: SessionStore;
  currentSession: SessionData | null;
  navStack: Array<{projectName: string, sessionId: string}>;
}
```

Maintained by the agent process for the voice channel. Not shared with token-server.

### Token Server

- `/api/chat` accepts `projectName` and `sessionId` parameters — fully stateless
- Creates a temporary `SessionStore` for the target project per request
- Navigation MCP server callback can trigger context switch: returns `context_switched` SSE event telling frontend to update, and subsequent `/api/chat` requests use the new projectName/sessionId
- Checks if target chat is locked by voice (agent publishes active chat via shared state file or in-memory)

### Agent (Voice)

- Holds `ProjectContext` for the voice session lifetime
- Navigation MCP server callback triggers context switch within LiveKit session
- Voice continues in new context without reconnecting
- Sends `context_switched` data channel event to frontend
- Publishes active `{projectName, sessionId}` to a lock file so token-server can check conflicts

## Frontend Notifications

On receiving `context_switched` event (via SSE or data channel):

1. Update `sessionState.currentSessionId` and new `sessionState.currentProject`
2. Reload conversation (fetch session transcript)
3. Reload session list for new project
4. Update session bar (project name + chat name)
5. Highlight active chat in sidebar

Detailed UI changes are scope of Spec 2.

## Docker Changes

### New volume

```yaml
volumes:
  - workspace:/app/workspace
```

Replaces `session-data` volume. Sessions now live inside workspace.

### Workspace initialization

On first start, create `_global/` with empty `sessions/index.json`, default `.mcp.json`, default `CLAUDE.md`.

Migrate existing sessions from `data/sessions/` to `workspace/_global/sessions/` if they exist.

## API Changes

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET | List projects |
| `/api/projects` | POST | Create project. Body: `{name, description?}` |
| `/api/projects/:name` | GET | Get project info |
| `/api/projects/:name` | PATCH | Update project. Body: `{description?}` |
| `/api/projects/:name/sessions` | GET | List sessions in project. Optional `?q=` |
| `/api/projects/:name/sessions/:id` | GET | Get session transcript |
| `/api/projects/:name/sessions/:id` | PATCH | Update session (rename) |
| `/api/projects/:name/sessions/:id/generate-name` | POST | AI-generate session name |
| `/api/chat` | POST | Body gains `projectName?` field |

Existing `/api/sessions` endpoints become `/api/projects/_global/sessions` (backward compat redirect optional).

## Out of Scope (Spec 2)

- Sidebar UI for projects (project list, project switcher)
- File browser within project
- File upload via UI
- `.mcp.json` / `CLAUDE.md` editing via GUI
- Project deletion
- Session deletion
