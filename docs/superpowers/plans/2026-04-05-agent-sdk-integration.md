# Claude Agent SDK Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom ToolLLM plugin with an AgentLLM plugin wrapping Claude Agent SDK, giving the voice assistant full Claude Code capabilities.

**Architecture:** New `AgentLLM` class extends LiveKit `llm.LLM`, holds a persistent Claude Agent SDK v2 session. User text from STT flows into `session.send()`, streaming text deltas flow back into the LiveKit pipeline via `queue.put()`, then to TTS. `canUseTool` callback controls permissions and sends events to the web client.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `@livekit/agents`

---

## File Structure

```
src/
├── agent.ts                    # Modify: swap ToolLLM → AgentLLM
├── plugins/
│   ├── agent-llm.ts            # Create: AgentLLM + AgentLLMStream
│   ├── tool-llm.ts             # Delete
│   └── tools.ts                # Delete
web/
├── app.js                      # Modify: handle tool_use events in log
```

---

### Task 1: Install Claude Agent SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

```bash
cd /Users/jdk/work/incubator/realtimeApi
npm install @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Verify installation**

```bash
node -e "const sdk = require('@anthropic-ai/claude-agent-sdk'); console.log('OK')"
```

Expected: `OK` (or similar — the package may be ESM-only, in which case verify with):

```bash
node --input-type=module -e "import '@anthropic-ai/claude-agent-sdk'; console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @anthropic-ai/claude-agent-sdk dependency"
```

---

### Task 2: Create AgentLLM plugin

**Files:**
- Create: `src/plugins/agent-llm.ts`

- [ ] **Step 1: Create agent-llm.ts**

```typescript
import { llm } from '@livekit/agents';
import {
  unstable_v2_createSession,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk';

export type EventSender = (event: Record<string, unknown>) => void;

interface AgentLLMOptions {
  model?: string;
  onEvent?: EventSender;
}

const SYSTEM_INSTRUCTIONS = `You are a helpful voice assistant. Respond concisely. You speak Czech and English — respond in the language the user speaks.

IMPORTANT: Your text output is read aloud by a text-to-speech engine. Format everything for spoken delivery:
- No markdown formatting (no **, no #, no bullet points)
- Write numbers as words: "dva stupně Celsia" not "2 °C", "pět set" not "500"
- You CAN use lists, but write them as spoken language: "zaprvé... zadruhé... zatřetí..." not "1. 2. 3."
- No special characters, symbols, or abbreviations — spell everything out phonetically
- Write units as words: "kilogramů" not "kg", "procent" not "%"
- Spell out acronyms letter by letter with spaces: "A P I" not "API", "H T T P" not "HTTP", "U R L" not "URL"
- No URLs — describe the source instead
- Keep responses short and conversational — this is a voice conversation, not a document`;

export class AgentLLM extends llm.LLM {
  #model: string;
  #onEvent: EventSender;
  #session: SDKSession | null = null;
  #streamIter: AsyncGenerator<any> | null = null;
  #sessionReady: boolean = false;

  constructor(opts: AgentLLMOptions = {}) {
    super();
    this.#model = opts.model || 'claude-sonnet-4-6';
    this.#onEvent = opts.onEvent || (() => {});
  }

  label(): string {
    return 'agent-llm';
  }

  get model(): string {
    return this.#model;
  }

  #initSession(): void {
    console.log('[AgentLLM] Creating new session...');
    this.#onEvent({ type: 'agent_sdk', event: 'session_creating' });

    this.#session = unstable_v2_createSession({
      model: this.#model,
      permissionMode: 'default',
      canUseTool: async (toolName, input, options) => {
        const inputStr = JSON.stringify(input).slice(0, 200);
        console.log(`[AgentLLM] Tool request: ${toolName} — ${inputStr}`);
        this.#onEvent({
          type: 'tool_use',
          tool: toolName,
          input: inputStr,
          title: options.title || toolName,
        });

        // Deny dangerous operations
        if (toolName === 'Bash') {
          const cmd = (input.command as string) || '';
          if (/rm\s+-rf|sudo|shutdown|reboot/i.test(cmd)) {
            this.#onEvent({ type: 'tool_denied', tool: toolName, input: inputStr, reason: 'dangerous command' });
            return { behavior: 'deny' as const, message: 'This command is not allowed.' };
          }
        }

        return { behavior: 'allow' as const };
      },
    });

    this.#streamIter = this.#session.stream();
    console.log('[AgentLLM] Session created');
    this.#onEvent({ type: 'agent_sdk', event: 'session_created' });
  }

  chat(opts: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: any;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new AgentLLMStream(this, {
      chatCtx: opts.chatCtx,
      connOptions: opts.connOptions || { timeoutMs: 60000 },
      getSession: () => {
        if (!this.#session) this.#initSession();
        return { session: this.#session!, streamIter: this.#streamIter! };
      },
      isFirstMessage: !this.#sessionReady,
      markReady: () => { this.#sessionReady = true; },
      onEvent: this.#onEvent,
      resetSession: () => {
        console.log('[AgentLLM] Resetting session');
        try { this.#session?.close(); } catch {}
        this.#session = null;
        this.#streamIter = null;
        this.#sessionReady = false;
      },
    });
  }

  async aclose(): Promise<void> {
    try { this.#session?.close(); } catch {}
    this.#session = null;
    this.#streamIter = null;
  }
}

class AgentLLMStream extends llm.LLMStream {
  #getSession: () => { session: SDKSession; streamIter: AsyncGenerator<any> };
  #isFirstMessage: boolean;
  #markReady: () => void;
  #onEvent: EventSender;
  #resetSession: () => void;

  constructor(
    llmInstance: AgentLLM,
    opts: {
      chatCtx: llm.ChatContext;
      connOptions: any;
      getSession: () => { session: SDKSession; streamIter: AsyncGenerator<any> };
      isFirstMessage: boolean;
      markReady: () => void;
      onEvent: EventSender;
      resetSession: () => void;
    },
  ) {
    super(llmInstance, {
      chatCtx: opts.chatCtx,
      connOptions: opts.connOptions,
    });
    this.#getSession = opts.getSession;
    this.#isFirstMessage = opts.isFirstMessage;
    this.#markReady = opts.markReady;
    this.#onEvent = opts.onEvent;
    this.#resetSession = opts.resetSession;
  }

  protected async run(): Promise<void> {
    // Extract latest user message from chatCtx
    const items = this.chatCtx.items;
    let userText = '';
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] as any;
      if (item.role === 'user') {
        if (typeof item.content === 'string') {
          userText = item.content;
        } else if (Array.isArray(item.content)) {
          userText = item.content
            .filter((c: any) => typeof c === 'string')
            .join(' ');
        }
        break;
      }
    }

    if (!userText) return;

    try {
      const { session, streamIter } = this.#getSession();

      // Prepend system instructions to first message
      const messageText = this.#isFirstMessage
        ? `${SYSTEM_INSTRUCTIONS}\n\n---\n\nUser says: ${userText}`
        : userText;

      await session.send(messageText);
      this.#markReady();

      const requestId = `agent-${Date.now()}`;

      // Read stream until we get a result (turn complete)
      for await (const msg of streamIter) {
        if (this.abortController.signal.aborted) break;

        // Streaming text deltas
        if (msg.type === 'stream_event') {
          const evt = msg.event;
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            this.queue.put({
              id: requestId,
              delta: { role: 'assistant', content: evt.delta.text },
            });
          }
        }

        // Complete assistant message — extract usage
        if (msg.type === 'assistant') {
          const usage = msg.message?.usage;
          if (usage) {
            this.queue.put({
              id: requestId,
              usage: {
                completionTokens: usage.output_tokens || 0,
                promptTokens: usage.input_tokens || 0,
                promptCachedTokens: 0,
                totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
              },
            });
          }
        }

        // Result means turn is complete
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            this.#onEvent({ type: 'agent_sdk', event: 'turn_complete', cost: msg.total_cost_usd });
          } else if (msg.subtype === 'error') {
            console.error('[AgentLLM] Turn error:', msg.error);
            this.#onEvent({ type: 'agent_sdk', event: 'turn_error', error: String(msg.error) });
          }
          break;
        }

        // Session state changes
        if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
          this.#onEvent({ type: 'agent_sdk', event: 'state', state: msg.state });
        }
      }
    } catch (err) {
      console.error('[AgentLLM] Stream error:', err);
      this.#onEvent({ type: 'agent_sdk', event: 'error', error: String(err) });
      this.#resetSession();
      throw err;
    }
  }
}
```

- [ ] **Step 2: Build and verify compilation**

```bash
npm run build
```

Expected: compiles successfully. Note: Agent SDK types may need adjustments based on actual installed version.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/agent-llm.ts
git commit -m "feat: AgentLLM plugin wrapping Claude Agent SDK"
```

---

### Task 3: Wire AgentLLM into agent.ts

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Replace ToolLLM with AgentLLM**

Replace the import and usage in `src/agent.ts`:

Change:
```typescript
import { ToolLLM } from './plugins/tool-llm.js';
```
To:
```typescript
import { AgentLLM } from './plugins/agent-llm.js';
```

Change the `llm` line in `AgentSession`:
```typescript
      llm: new AgentLLM({
        model: 'claude-sonnet-4-6',
        onEvent: sendEvent,
      }),
```

Remove the system prompt from `voice.Agent` instructions (it's now in AgentLLM):
```typescript
    const agent = new voice.Agent({
      instructions: '',
    });
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Expected: compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: wire AgentLLM into voice pipeline"
```

---

### Task 4: Update web client event log

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Add agent_sdk and tool_use event handlers**

In the `DataReceived` handler in `web/app.js`, after the `error` handler, add:

```javascript
    // Agent SDK events
    else if (msg.type === 'agent_sdk') {
      logEvent('agent', `${msg.event}${msg.state ? ': ' + msg.state : ''}${msg.cost != null ? ' ($' + msg.cost.toFixed(4) + ')' : ''}${msg.error ? ': ' + msg.error : ''}`);
    }

    // Tool use (Claude Agent SDK tools)
    else if (msg.type === 'tool_use') {
      logEvent('tool_call', `${msg.title || msg.tool}: ${msg.input}`);
    }

    // Tool denied
    else if (msg.type === 'tool_denied') {
      logEvent('error', `DENIED ${msg.tool}: ${msg.reason}`);
    }
```

- [ ] **Step 2: Add CSS for agent event type**

In `web/style.css`, add after `.log-type.error`:

```css
.log-type.agent { color: #06b6d4; }
```

- [ ] **Step 3: Commit**

```bash
git add web/app.js web/style.css
git commit -m "feat: agent SDK events in web client event log"
```

---

### Task 5: Delete old plugin files

**Files:**
- Delete: `src/plugins/tool-llm.ts`
- Delete: `src/plugins/tools.ts`

- [ ] **Step 1: Remove old files**

```bash
rm src/plugins/tool-llm.ts src/plugins/tools.ts
```

- [ ] **Step 2: Build and verify no broken imports**

```bash
npm run build
```

Expected: compiles successfully (no references to deleted files remain).

- [ ] **Step 3: Commit**

```bash
git add -u src/plugins/tool-llm.ts src/plugins/tools.ts
git commit -m "chore: remove old ToolLLM plugin files"
```

---

### Task 6: End-to-end test

**Files:** None (manual testing)

- [ ] **Step 1: Start all services**

```bash
docker compose up -d
npm run build
npm run dev
```

- [ ] **Step 2: Open browser and test basic conversation**

Open http://localhost:3001, click Connect, say "Ahoj, jak se máš?"

Expected:
- Agent creates session (event log shows `session_creating` → `session_created`)
- Claude responds in Czech via TTS
- Event log shows `turn_complete` with cost

- [ ] **Step 3: Test tool use**

Say "Jaký je aktuální čas?" or "Vytvoř soubor test.txt s textem ahoj"

Expected:
- Event log shows `tool_call` entries (Bash, Write, etc.)
- Claude executes tool and responds vocally with the result
- If dangerous command, event log shows `DENIED`

- [ ] **Step 4: Test session persistence**

Have a multi-turn conversation — Claude should remember context from previous turns without re-creating the session.

- [ ] **Step 5: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: Claude Agent SDK integration complete"
git push
```
