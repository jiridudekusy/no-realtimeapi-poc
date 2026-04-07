# Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session history with sidebar UI — browse past sessions, read transcripts, fulltext search, and resume conversations with full Claude context.

**Architecture:** New `SessionStore` class handles JSON file persistence in `data/sessions/`. Token server exposes read-only API (`/api/sessions`). Agent creates/updates sessions during conversation and broadcasts sessionId via data channel. Web client sends `session_init` message after connect to signal resume. Frontend adds a sidebar with session list, search, and read-only transcript view.

**Tech Stack:** TypeScript (ESM), Express v5, vanilla HTML/CSS/JS, JSON file storage

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/session-store.ts` | Create | Session CRUD — read/write JSON files, index management, search |
| `src/token-server.ts` | Modify | Add `/api/sessions` and `/api/sessions/:id` endpoints |
| `src/plugins/agent-sdk-handler.ts` | Modify | Accept initial `claudeSessionId` for resume, expose `getSessionId()` and message callbacks |
| `src/agent.ts` | Modify | Session lifecycle — create/load/save, broadcast `session_info`, listen for `session_init` |
| `web/index.html` | Modify | Add sidebar HTML, hamburger button, wrapper div |
| `web/style.css` | Modify | Sidebar styles, two-column layout, responsive, read-only view, mobile overlay |
| `web/app.js` | Modify | Sidebar logic, session list, search, read-only transcript, resume flow |
| `docker-compose.yml` | Modify | Add `session-data` volume |
| `docker-compose.prod.yml` | Modify | Add `session-data` volume |

---

### Task 1: Session Store

**Files:**
- Create: `src/session-store.ts`

- [ ] **Step 1: Create the SessionStore class with types**

```typescript
// src/session-store.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: string;
  name?: string;       // tool name (for role=tool)
  input?: string;      // tool input (for role=tool)
  output?: string;     // tool output (for role=tool)
}

export interface SessionMeta {
  sessionId: string;
  claudeSessionId: string | null;
  created: string;
  updated: string;
  preview: string;
  messageCount: number;
}

export interface SessionData {
  sessionId: string;
  claudeSessionId: string | null;
  created: string;
  messages: SessionMessage[];
}

export class SessionStore {
  #dir: string;
  #indexPath: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#indexPath = path.join(dir, 'index.json');
  }

  async init(): Promise<void> {
    if (!existsSync(this.#dir)) {
      await mkdir(this.#dir, { recursive: true });
    }
    if (!existsSync(this.#indexPath)) {
      await writeFile(this.#indexPath, '[]', 'utf-8');
    }
  }

  async listSessions(query?: string): Promise<SessionMeta[]> {
    const index = await this.#readIndex();
    let results = index.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

    if (query) {
      const q = query.toLowerCase();
      const matched: SessionMeta[] = [];
      for (const meta of results) {
        // Check preview first
        if (meta.preview.toLowerCase().includes(q)) {
          matched.push(meta);
          continue;
        }
        // Check full transcript
        const session = await this.getSession(meta.sessionId);
        if (session && session.messages.some(m => m.text.toLowerCase().includes(q))) {
          matched.push(meta);
        }
      }
      results = matched;
    }

    return results;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const filePath = path.join(this.#dir, `${sessionId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as SessionData;
    } catch {
      return null;
    }
  }

  async createSession(): Promise<SessionData> {
    const sessionId = randomUUID();
    const session: SessionData = {
      sessionId,
      claudeSessionId: null,
      created: new Date().toISOString(),
      messages: [],
    };
    await this.#writeSession(session);
    await this.#addToIndex(session);
    return session;
  }

  async addMessage(sessionId: string, message: SessionMessage): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.messages.push(message);
    await this.#writeSession(session);
    await this.#updateIndex(sessionId, {
      updated: new Date().toISOString(),
      messageCount: session.messages.length,
      preview: this.#extractPreview(session),
    });
  }

  async setClaudeSessionId(sessionId: string, claudeSessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.claudeSessionId = claudeSessionId;
    await this.#writeSession(session);
    await this.#updateIndex(sessionId, { claudeSessionId });
  }

  #extractPreview(session: SessionData): string {
    const firstUserMsg = session.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return '(empty)';
    return firstUserMsg.text.length > 50
      ? firstUserMsg.text.slice(0, 50) + '...'
      : firstUserMsg.text;
  }

  async #readIndex(): Promise<SessionMeta[]> {
    try {
      const data = await readFile(this.#indexPath, 'utf-8');
      return JSON.parse(data) as SessionMeta[];
    } catch {
      return [];
    }
  }

  async #writeIndex(index: SessionMeta[]): Promise<void> {
    await writeFile(this.#indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  async #writeSession(session: SessionData): Promise<void> {
    const filePath = path.join(this.#dir, `${session.sessionId}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  async #addToIndex(session: SessionData): Promise<void> {
    const index = await this.#readIndex();
    index.push({
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      created: session.created,
      updated: session.created,
      preview: '(new session)',
      messageCount: 0,
    });
    await this.#writeIndex(index);
  }

  async #updateIndex(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
    const index = await this.#readIndex();
    const entry = index.find(e => e.sessionId === sessionId);
    if (entry) {
      Object.assign(entry, updates);
      await this.#writeIndex(index);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/jdk/work/incubator/realtimeApi && npx tsc --noEmit src/session-store.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/session-store.ts
git commit -m "feat: add SessionStore for session persistence"
```

---

### Task 2: Token Server API Endpoints

**Files:**
- Modify: `src/token-server.ts`

- [ ] **Step 1: Add session imports and initialize store**

At top of `src/token-server.ts`, after existing imports, add:

```typescript
import { SessionStore } from './session-store.js';

const sessionStore = new SessionStore(
  path.resolve(__dirname, '..', 'data', 'sessions'),
);
await sessionStore.init();
```

- [ ] **Step 2: Add GET /api/sessions endpoint**

After the `/api/health` endpoint, add:

```typescript
app.get('/api/sessions', async (req, res) => {
  try {
    const q = req.query.q as string | undefined;
    const sessions = await sessionStore.listSessions(q);
    res.json(sessions);
  } catch (err) {
    console.error('Failed to list sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});
```

- [ ] **Step 3: Add GET /api/sessions/:id endpoint**

After the `/api/sessions` endpoint, add:

```typescript
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('Failed to get session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/jdk/work/incubator/realtimeApi && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/token-server.ts
git commit -m "feat: add /api/sessions endpoints to token server"
```

---

### Task 3: Agent SDK Handler — Session ID Access + Message Callbacks

**Files:**
- Modify: `src/plugins/agent-sdk-handler.ts`

The handler already captures `claudeSessionId` internally. We need to:
1. Accept an initial `claudeSessionId` for resume (set in constructor options)
2. Expose a getter for `claudeSessionId`
3. Add callbacks for when messages are received (so agent.ts can persist them)

- [ ] **Step 1: Add new options and getter**

In `src/plugins/agent-sdk-handler.ts`, modify the `AgentSDKHandlerOptions` interface and constructor:

```typescript
interface AgentSDKHandlerOptions {
  model?: string;
  onEvent?: EventSender;
  claudeSessionId?: string;
  onAssistantMessage?: (text: string) => void;
  onToolCall?: (name: string, input: string) => void;
}
```

In the constructor, after the existing assignments:

```typescript
  constructor(opts: AgentSDKHandlerOptions = {}) {
    this.#model = opts.model || 'claude-sonnet-4-6';
    this.#onEvent = opts.onEvent || (() => {});
    this.#sessionId = opts.claudeSessionId || null;
    this.#onAssistantMessage = opts.onAssistantMessage || (() => {});
    this.#onToolCall = opts.onToolCall || (() => {});
  }
```

Add private fields after existing ones:

```typescript
  #onAssistantMessage: (text: string) => void;
  #onToolCall: (name: string, input: string) => void;
```

Add a public getter:

```typescript
  get claudeSessionId(): string | null {
    return this.#sessionId;
  }
```

- [ ] **Step 2: Call onAssistantMessage when result text is emitted**

In the `sendAndStream` method, at line 134-137 (the `msg.type === 'result'` block where remaining fullText is emitted), after `onSentence(fullText.trim())` add:

```typescript
            this.#onAssistantMessage(fullText.trim());
```

Also, in the sentence emission loops (lines 160-164 and 193-198), after each `onSentence(sentence.trim())` add:

```typescript
                this.#onAssistantMessage(sentence.trim());
```

Actually, it's cleaner to call `onAssistantMessage` once with the complete response at the result stage. Change approach — track all emitted text and call once:

In `sendAndStream`, add a variable at the top of the method (after `let fullText = ''`):

```typescript
    let allEmittedText = '';
```

Wrap `onSentence` calls to also accumulate:

At each place where `onSentence(sentence.trim())` or `onSentence(fullText.trim())` is called, also do:

```typescript
    allEmittedText += sentence.trim() + ' ';
```

Then in the `msg.type === 'result'` block, after the existing code and before `break`, add:

```typescript
          // Notify about complete assistant message
          if (allEmittedText.trim()) {
            this.#onAssistantMessage(allEmittedText.trim());
          }
```

- [ ] **Step 3: Call onToolCall when tool_use blocks are found**

In the existing tool_use detection block (lines 171-182), after `onToolCall?.()`, add:

```typescript
              this.#onToolCall(block.name, inputStr);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/jdk/work/incubator/realtimeApi && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/plugins/agent-sdk-handler.ts
git commit -m "feat: expose claudeSessionId and message callbacks on AgentSDKHandler"
```

---

### Task 4: Agent — Session Lifecycle

**Files:**
- Modify: `src/agent.ts`

This is the core integration: create/load sessions, persist messages, broadcast session info, listen for `session_init` from web client.

- [ ] **Step 1: Import SessionStore and add initialization**

At the top of `src/agent.ts`, add import:

```typescript
import { SessionStore, type SessionMessage } from './session-store.js';
import path from 'node:path';
```

Inside the `entry` function, before the `AgentSDKHandler` creation (line 31), add:

```typescript
    // Session store
    const sessionStore = new SessionStore(
      path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data', 'sessions'),
    );
    await sessionStore.init();

    let currentSession = await sessionStore.createSession();
    console.log(`[Agent] New session: ${currentSession.sessionId}`);
```

- [ ] **Step 2: Listen for session_init and session_resume from web client**

In the existing `ctx.room.on('dataReceived', ...)` handler, add a new case inside the try block (after the `llm_hold` check):

```typescript
        if (msg.type === 'session_init' && msg.sessionId) {
          // Resume an existing session
          const existing = await sessionStore.getSession(msg.sessionId);
          if (existing) {
            currentSession = existing;
            console.log(`[Agent] Resuming session: ${currentSession.sessionId} (claude: ${currentSession.claudeSessionId})`);
            // Reinitialize Claude with existing sessionId
            claude.close();
            claude = new AgentSDKHandler({
              model: 'claude-sonnet-4-6',
              claudeSessionId: currentSession.claudeSessionId || undefined,
              onEvent: sendEvent,
              onAssistantMessage: (text) => handleAssistantMessage(text),
              onToolCall: (name, input) => handleToolCall(name, input),
            });
          }
          // Broadcast session info to web client
          sendEvent({ type: 'session_info', sessionId: currentSession.sessionId });
        }
```

Note: `claude` needs to be declared with `let` instead of `const` for this to work. Change line 31 from `const claude = ...` to `let claude = ...`.

- [ ] **Step 3: Add message persistence callbacks**

Before the `AgentSDKHandler` creation, add helper functions:

```typescript
    async function handleAssistantMessage(text: string) {
      const msg: SessionMessage = {
        role: 'assistant',
        text,
        timestamp: new Date().toISOString(),
      };
      await sessionStore.addMessage(currentSession.sessionId, msg);

      // Capture claudeSessionId if we have it now
      if (claude.claudeSessionId && !currentSession.claudeSessionId) {
        currentSession.claudeSessionId = claude.claudeSessionId;
        await sessionStore.setClaudeSessionId(currentSession.sessionId, claude.claudeSessionId);
        console.log(`[Agent] Session ${currentSession.sessionId} linked to Claude session: ${claude.claudeSessionId}`);
      }
    }

    async function handleToolCall(name: string, input: string) {
      const msg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await sessionStore.addMessage(currentSession.sessionId, msg);
    }
```

- [ ] **Step 4: Update AgentSDKHandler creation to include callbacks**

Change the `AgentSDKHandler` constructor call:

```typescript
    let claude = new AgentSDKHandler({
      model: 'claude-sonnet-4-6',
      onEvent: sendEvent,
      onAssistantMessage: (text) => handleAssistantMessage(text),
      onToolCall: (name, input) => handleToolCall(name, input),
    });
```

- [ ] **Step 5: Persist user messages in processUserText**

At the beginning of the `processUserText` function, add:

```typescript
      // Persist user message
      const userMsg: SessionMessage = {
        role: 'user',
        text: userText,
        timestamp: new Date().toISOString(),
      };
      sessionStore.addMessage(currentSession.sessionId, userMsg).catch(err =>
        console.error('[Agent] Failed to persist user message:', err)
      );
```

- [ ] **Step 6: Broadcast session_info after participant joins**

After `await ctx.waitForParticipant()` at the end of the entry function, add:

```typescript
    // Broadcast current session to web client
    sendEvent({ type: 'session_info', sessionId: currentSession.sessionId });
```

- [ ] **Step 7: Update Close handler — don't clear claudeSessionId**

In the `Close` event handler (line 66-70), change `claude.close()` to just `claude.interrupt()` — we want to keep the claudeSessionId for future resume:

```typescript
    agentSession.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.log('Session closed:', ev.reason, ev.error);
      sendEvent({ type: 'error', reason: ev.reason, error: ev.error ? String(ev.error) : null });
      claude.interrupt();
    });
```

- [ ] **Step 8: Verify it compiles**

Run: `cd /Users/jdk/work/incubator/realtimeApi && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/agent.ts
git commit -m "feat: integrate session store into agent lifecycle"
```

---

### Task 5: Docker — Session Data Volume

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add volume to docker-compose.yml**

In `docker-compose.yml`, add `session-data` volume to the agent service's volumes (after `claude-auth:/home/node/.claude`):

```yaml
      - session-data:/app/data/sessions
```

And add to the top-level `volumes:` section:

```yaml
volumes:
  claude-auth:
  session-data:
```

- [ ] **Step 2: Add volume to docker-compose.prod.yml**

Same changes in `docker-compose.prod.yml`:

Add to agent service volumes:
```yaml
      - session-data:/app/data/sessions
```

Add to top-level volumes:
```yaml
volumes:
  claude-auth:
  session-data:
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "feat: add session-data Docker volume for persistence"
```

---

### Task 6: Frontend — HTML Sidebar Structure

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add wrapper div and sidebar HTML**

Replace the current `<div id="app">` structure. Wrap it in a layout container with a sidebar:

Change `web/index.html` body content to:

```html
<body>
  <div id="layout">
    <!-- Sidebar -->
    <aside id="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Sessions</span>
        <button id="sidebar-close" class="sidebar-close">✕</button>
      </div>
      <input id="session-search" type="text" placeholder="Search sessions..." class="session-search" />
      <button id="new-session-btn" class="new-session-btn">+ New Session</button>
      <div id="session-list" class="session-list"></div>
    </aside>
    <div id="sidebar-overlay" class="sidebar-overlay"></div>

    <!-- Main app (existing layout) -->
    <div id="app">
      <header>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <button id="hamburger-btn" class="hamburger-btn">☰</button>
          <h1>Voice Assistant</h1>
        </div>
        <div style="display: flex; align-items: center; gap: 0.8rem;">
          <span id="server-status" class="server-status checking">Server: ...</span>
          <span id="status" class="status disconnected">● Disconnected</span>
          <button id="theme-btn" class="theme-btn" title="Toggle light/dark mode">☀️</button>
        </div>
      </header>

      <!-- Read-only session header (hidden by default) -->
      <div id="readonly-header" class="readonly-header" style="display: none;">
        <div class="readonly-info">
          <span id="readonly-title" class="readonly-title"></span>
          <span id="readonly-meta" class="readonly-meta"></span>
        </div>
        <button id="resume-btn" class="resume-btn">▶ Resume</button>
      </div>

      <div id="mic-section">
        <button id="mic-btn" class="mic-btn" disabled>🎙️</button>
        <div id="mic-label">Connect to start</div>
      </div>

      <div id="conversation"></div>

      <div id="controls">
        <button id="connect-btn">Connect</button>
        <button id="disconnect-btn" disabled>Disconnect</button>
        <button id="hold-btn" class="hold-btn" disabled>LLM: Auto</button>
      </div>

      <div id="latency-bar">
        <span>STT <strong id="lat-stt">—</strong></span>
        <span>LLM <strong id="lat-llm">—</strong></span>
        <span>TTS <strong id="lat-tts">—</strong></span>
        <span>Total <strong id="lat-total">—</strong></span>
      </div>

      <div id="cost-bar">
        <span>Tokens: <strong id="cost-tokens">0</strong></span>
        <span>TTS chars: <strong id="cost-chars">0</strong></span>
        <span>Est. cost: <strong id="cost-total">$0.000</strong></span>
      </div>

      <!-- Read-only footer (hidden by default) -->
      <div id="readonly-footer" class="readonly-footer" style="display: none;">
        📖 Read-only transcript · Click <strong>Resume</strong> to continue
      </div>

      <details id="event-log-details" open>
        <summary>Server Events <button id="copy-log-btn">Copy</button></summary>
        <div id="event-log"></div>
      </details>
    </div>
  </div>

  <script type="module" src="app.js"></script>
</body>
```

- [ ] **Step 2: Verify page loads**

Open `http://localhost:3001` in browser. The layout should appear with a sidebar on the left (or hamburger on mobile). The chat area should work as before.

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat: add sidebar HTML structure for session history"
```

---

### Task 7: Frontend — CSS Sidebar + Responsive

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Add layout and sidebar styles**

At the top of `web/style.css`, after the `* { margin: 0; ... }` reset, replace the `body` rule and add layout styles. The `body` rule needs to change from centering `#app` to filling the viewport:

Replace:
```css
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  display: flex;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
}
```

With:
```css
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  min-height: 100vh;
}

#layout {
  display: flex;
  min-height: 100vh;
}
```

Change `#app` from fixed 480px to flex child:

Replace:
```css
#app {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
```

With:
```css
#app {
  flex: 1;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 2rem;
}
```

- [ ] **Step 2: Add sidebar CSS**

Add these styles after the `#app` rule:

```css
/* --- Sidebar --- */
#sidebar {
  width: 280px;
  flex-shrink: 0;
  background: #111;
  border-right: 1px solid #222;
  display: flex;
  flex-direction: column;
  padding: 1rem;
  overflow-y: auto;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.sidebar-title { font-weight: bold; font-size: 1rem; }

.sidebar-close {
  display: none;
  background: none;
  border: none;
  color: #888;
  font-size: 1.2rem;
  cursor: pointer;
}

.session-search {
  width: 100%;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  color: #ccc;
  font-size: 0.85rem;
  outline: none;
  margin-bottom: 0.5rem;
}
.session-search:focus { border-color: #2563eb; }

.new-session-btn {
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
  margin-bottom: 0.75rem;
}
.new-session-btn:hover { background: #1d4ed8; }

.session-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  overflow-y: auto;
}

.session-item {
  border: 1px solid #222;
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  transition: background 0.15s;
}
.session-item:hover { background: rgba(255,255,255,0.05); }
.session-item.active { background: rgba(37,99,235,0.15); border-color: rgba(37,99,235,0.3); }
.session-item.active .session-preview { color: #93c5fd; font-weight: 600; }
.session-item.viewing { background: rgba(168,85,247,0.15); border-color: rgba(168,85,247,0.3); }
.session-item.viewing .session-preview { color: #c084fc; font-weight: 600; }

.session-preview { font-size: 0.8rem; color: #999; }
.session-meta { font-size: 0.7rem; color: #555; margin-top: 0.2rem; }

/* Hamburger — visible on mobile only */
.hamburger-btn {
  display: none;
  background: none;
  border: none;
  color: #ccc;
  font-size: 1.3rem;
  cursor: pointer;
  padding: 0;
}

/* Overlay — mobile only */
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 9;
}

/* Read-only header */
.readonly-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid #222;
}
.readonly-info { display: flex; flex-direction: column; }
.readonly-title { font-weight: bold; font-size: 1rem; }
.readonly-meta { font-size: 0.75rem; color: #666; }
.resume-btn {
  background: #a855f7;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.resume-btn:hover { background: #9333ea; }

/* Read-only footer */
.readonly-footer {
  text-align: center;
  font-size: 0.8rem;
  color: #666;
  padding: 0.5rem;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
}
.readonly-footer strong { color: #c084fc; }
```

- [ ] **Step 3: Add responsive (mobile) styles**

Add at the bottom of the file, before the existing `@media (prefers-color-scheme: light)` block:

```css
/* --- Mobile: sidebar as overlay --- */
@media (max-width: 640px) {
  #sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 10;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }
  #sidebar.open {
    transform: translateX(0);
  }
  .sidebar-overlay.open {
    display: block;
  }
  .sidebar-close { display: block; }
  .hamburger-btn { display: block; }
  #app { padding: 1rem; }
}
```

- [ ] **Step 4: Add light mode overrides for sidebar**

In the existing `body.light` section, add:

```css
body.light #sidebar { background: #f9f9f9; border-right-color: #e0e0e0; }
body.light .session-search { background: #fff; border-color: #ddd; color: #333; }
body.light .session-item { border-color: #e0e0e0; }
body.light .session-item:hover { background: rgba(0,0,0,0.03); }
body.light .session-item.active { background: rgba(37,99,235,0.08); border-color: rgba(37,99,235,0.2); }
body.light .session-item.active .session-preview { color: #1d4ed8; }
body.light .session-item.viewing { background: rgba(168,85,247,0.08); border-color: rgba(168,85,247,0.2); }
body.light .session-item.viewing .session-preview { color: #7c3aed; }
body.light .session-preview { color: #555; }
body.light .session-meta { color: #999; }
body.light .readonly-header { border-bottom-color: #e0e0e0; }
body.light .readonly-footer { background: rgba(0,0,0,0.03); }
```

Also duplicate these in the `@media (prefers-color-scheme: light)` block using `body:not(.dark)` selector prefix (same as existing pattern).

- [ ] **Step 5: Verify layout**

Open `http://localhost:3001` — sidebar should be visible on desktop, hamburger on mobile (resize browser to <640px).

- [ ] **Step 6: Commit**

```bash
git add web/style.css
git commit -m "feat: add sidebar and responsive CSS for session history"
```

---

### Task 8: Frontend — JS Sidebar Logic, Session List, Search

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Add session state and sidebar toggle**

After the existing `state` object (line 57-62), add:

```javascript
// --- Session state ---
const sessionState = {
  currentSessionId: null, // active live session
  viewingSessionId: null, // read-only viewing
  sessions: [],
};

// --- Sidebar toggle (mobile) ---
$('#hamburger-btn').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#sidebar-overlay').classList.add('open');
});
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#sidebar-overlay').addEventListener('click', closeSidebar);

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('open');
}
```

- [ ] **Step 2: Add session list fetching and rendering**

```javascript
// --- Session list ---
async function fetchSessions(query) {
  const url = query ? `/api/sessions?q=${encodeURIComponent(query)}` : '/api/sessions';
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    sessionState.sessions = await res.json();
    renderSessionList();
  } catch (err) {
    console.error('Failed to fetch sessions:', err);
  }
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of sessionState.sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    if (s.sessionId === sessionState.currentSessionId) div.classList.add('active');
    if (s.sessionId === sessionState.viewingSessionId) div.classList.add('viewing');
    div.dataset.sessionId = s.sessionId;

    const date = new Date(s.updated);
    const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
    const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
      <div class="session-preview">${escapeHtml(s.preview)}</div>
      <div class="session-meta">${dateStr} ${timeStr} · ${s.messageCount} zpráv</div>
    `;
    div.addEventListener('click', () => onSessionClick(s.sessionId));
    list.appendChild(div);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch sessions on load
fetchSessions();
```

- [ ] **Step 3: Add search with debounce**

```javascript
// --- Search ---
let searchTimeout = null;
$('#session-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    fetchSessions(e.target.value.trim() || undefined);
  }, 300);
});
```

- [ ] **Step 4: Add session click handler — load read-only transcript**

```javascript
async function onSessionClick(sessionId) {
  // If clicking active session, just close sidebar on mobile
  if (sessionId === sessionState.currentSessionId) {
    closeSidebar();
    return;
  }

  // Load full transcript
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return;
    const session = await res.json();
    showReadOnlyTranscript(session);
    sessionState.viewingSessionId = sessionId;
    renderSessionList();
    closeSidebar();
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

function showReadOnlyTranscript(session) {
  // Show readonly header
  const firstMsg = session.messages.find(m => m.role === 'user');
  const preview = firstMsg ? firstMsg.text.slice(0, 60) : '(empty)';
  const date = new Date(session.created);
  const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

  $('#readonly-title').textContent = preview;
  $('#readonly-meta').textContent = `${dateStr} ${timeStr} · ${session.messages.length} zpráv`;
  $('#readonly-header').style.display = 'flex';
  $('#readonly-footer').style.display = 'block';

  // Hide live controls
  $('#mic-section').style.display = 'none';
  $('#controls').style.display = 'none';
  $('#latency-bar').style.display = 'none';
  $('#cost-bar').style.display = 'none';

  // Render transcript
  const conv = $('#conversation');
  conv.innerHTML = '';
  for (const msg of session.messages) {
    if (msg.role === 'tool') continue; // Skip tool calls in main view
    const div = document.createElement('div');
    div.className = `msg ${msg.role === 'user' ? 'user' : 'assistant'}`;

    const time = new Date(msg.timestamp);
    const ts = time.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${msg.role === 'user' ? 'Ty' : 'Asistent'} · ${ts}`;

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = msg.text;

    div.appendChild(meta);
    div.appendChild(body);
    conv.appendChild(div);
  }
  conv.scrollTop = conv.scrollHeight;

  // Store for resume
  $('#resume-btn').onclick = () => resumeSession(session.sessionId);
}

function exitReadOnlyMode() {
  sessionState.viewingSessionId = null;
  $('#readonly-header').style.display = 'none';
  $('#readonly-footer').style.display = 'none';
  $('#mic-section').style.display = '';
  $('#controls').style.display = '';
  $('#latency-bar').style.display = '';
  $('#cost-bar').style.display = '';
  $('#conversation').innerHTML = '';
  renderSessionList();
}
```

- [ ] **Step 5: Add resume flow**

```javascript
async function resumeSession(sessionId) {
  exitReadOnlyMode();
  try {
    const res = await fetch(`/api/token?session=${sessionId}`);
    const { token } = await res.json();

    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const livekitUrl = $('#app').dataset.livekitUrl || `${wsProto}://${window.location.hostname}:7880`;
    await room.connect(livekitUrl, token);

    state.connected = true;
    setStatus('Connected', 'connected');
    $('#connect-btn').disabled = true;
    $('#disconnect-btn').disabled = false;
    $('#mic-btn').disabled = false;
    $('#hold-btn').disabled = false;
    $('#mic-label').textContent = 'Click to toggle microphone';

    // Tell agent to resume this session
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: 'session_init', sessionId })),
      { reliable: true }
    );

    await room.localParticipant.setMicrophoneEnabled(true);
    $('#mic-btn').classList.add('active');
    $('#mic-label').textContent = 'Listening...';
    setStatus('Listening', 'listening');
  } catch (err) {
    console.error('Resume failed:', err);
    addMessage('assistant', `Resume error: ${err?.message || err}`);
  }
}
```

- [ ] **Step 6: Handle session_info from agent via data channel**

In the existing `RoomEvent.DataReceived` handler, add a new case for `session_info`:

```javascript
    // Session info from agent
    else if (msg.type === 'session_info') {
      sessionState.currentSessionId = msg.sessionId;
      sessionState.viewingSessionId = null;
      renderSessionList();
      fetchSessions(); // refresh list
    }
```

- [ ] **Step 7: Add "New Session" button handler**

```javascript
$('#new-session-btn').addEventListener('click', () => {
  if (state.connected) {
    room.disconnect();
  }
  exitReadOnlyMode();
  closeSidebar();
  // User clicks Connect to start new session
});
```

- [ ] **Step 8: Update disconnect handler to refresh session list**

In the existing `RoomEvent.Disconnected` handler, add at the end:

```javascript
  sessionState.currentSessionId = null;
  fetchSessions(); // refresh to show completed session
  renderSessionList();
```

- [ ] **Step 9: Verify full flow**

1. Open `http://localhost:3001`
2. Sidebar should show session list (empty initially)
3. Click Connect → new session created → session appears in sidebar
4. Speak → messages exchanged → disconnect
5. Session shows in sidebar with preview
6. Click on it → read-only transcript displayed
7. Click Resume → reconnects and resumes Claude context
8. Search works with debounce

- [ ] **Step 10: Commit**

```bash
git add web/app.js
git commit -m "feat: add sidebar JS — session list, search, read-only view, resume"
```

---

### Task 9: Update CLAUDE.md and README.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (if it exists)

- [ ] **Step 1: Update CLAUDE.md**

Add to the Architecture section:

```markdown
- `src/session-store.ts` — Session persistence (JSON files in data/sessions/), CRUD, fulltext search
- `data/sessions/` — Session data directory (Docker volume: session-data)
```

Add to Docker / LiveKit notes:

```markdown
- `session-data` Docker volume persists conversation transcripts in `/app/data/sessions`
- Each session has index entry (metadata) + full JSON file (transcript)
```

Add new section after Architecture:

```markdown
## Session History
- Sessions stored as JSON files in `data/sessions/` (index.json + per-session files)
- Agent creates sessions on connect, persists messages each turn
- Web client sends `session_init` via data channel to resume existing session
- API: GET /api/sessions(?q=search), GET /api/sessions/:id
- Resume uses Claude Agent SDK `resume: claudeSessionId` for full context
- Sidebar UI with search (desktop: always visible, mobile: hamburger overlay)
- Read-only transcript view with Resume button for past sessions
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md with session history architecture"
```

---

### Task 10: Integration Test — Full Flow Verification

No automated tests (project has no test framework), but verify the complete flow:

- [ ] **Step 1: Build and start**

```bash
cd /Users/jdk/work/incubator/realtimeApi
npm run build
```

Expected: Clean compilation, no errors.

- [ ] **Step 2: Verify data directory creation**

```bash
ls -la data/sessions/
```

Expected: Directory exists after first run (created by SessionStore.init()).

- [ ] **Step 3: Verify API endpoints**

```bash
curl -s http://localhost:3001/api/sessions | head -20
curl -s http://localhost:3001/api/sessions?q=test | head -20
```

Expected: Returns JSON array (empty if no sessions yet).

- [ ] **Step 4: Full manual test**

1. Open `http://localhost:3001`
2. Verify sidebar visible on desktop
3. Click Connect → speak → verify session appears in sidebar
4. Disconnect → session remains in sidebar
5. Click session → read-only transcript with Resume button
6. Click Resume → verify voice reconnects and Claude remembers context
7. Test search: type in search box → results filter
8. Resize to mobile → verify hamburger menu works
9. Test light/dark theme with sidebar

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for session history"
```
