# Pluggable Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all processors (VAD, STT, TTS, LLM) configurable via `pipeline.json` with support for OpenAI and OpenRouter as alternative LLM backends.

**Architecture:** Pipeline config loaded from `workspace/pipeline.json` (global) merged with `workspace/{project}/pipeline.json` (per-project override). LLM backends share a common `LLMHandler` interface. Non-Claude backends use OpenAI function calling for navigation tools, local message history for session persistence.

**Tech Stack:** TypeScript, OpenAI SDK (already in deps), LiveKit Agents plugins

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/plugins/llm-handler.ts` | **New** | `LLMHandler` interface + `LLMHandlerOptions` type |
| `src/plugins/agent-sdk-handler.ts` | Modify | Implement `LLMHandler` interface explicitly |
| `src/plugins/nav-functions.ts` | **New** | Navigation tools as OpenAI function definitions + executor |
| `src/plugins/openai-chat-handler.ts` | **New** | OpenAI/OpenRouter handler with function calling |
| `src/pipeline-config.ts` | **New** | Config types, defaults, loader, merge |
| `src/plugins/llm-factory.ts` | **New** | Factory: config → LLMHandler instance |
| `src/agent.ts` | Modify | Use pipeline config for VAD/STT/TTS/LLM |
| `src/token-server.ts` | Modify | Use pipeline config + LLM factory for chat endpoints |
| `src/workspace-init.ts` | Modify | Create default `pipeline.json` on init |

---

### Task 1: LLMHandler Interface

**Files:**
- Create: `src/plugins/llm-handler.ts`

- [ ] **Step 1: Create the interface file**

```typescript
// src/plugins/llm-handler.ts
export type EventSender = (event: Record<string, unknown>) => void;

export interface LLMHandlerOptions {
  model?: string;
  onEvent?: EventSender;
  claudeSessionId?: string;
  onAssistantMessage?: (text: string) => void;
  onToolCall?: (name: string, input: string) => void;
  onSessionIdCaptured?: (sessionId: string) => void;
  mcpServers?: Record<string, unknown>;
  additionalAllowedTools?: string[];
  cwd?: string;
  systemPrompt?: string;
  /** Local message history for backends without server-side persistence */
  messageHistory?: Array<{ role: string; text: string }>;
}

export interface LLMHandler {
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

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/plugins/llm-handler.ts
git commit -m "feat: add LLMHandler interface"
```

---

### Task 2: AgentSDKHandler implements LLMHandler

**Files:**
- Modify: `src/plugins/agent-sdk-handler.ts`

- [ ] **Step 1: Import and implement the interface**

In `src/plugins/agent-sdk-handler.ts`, replace the local `EventSender` type and `AgentSDKHandlerOptions` interface with imports from `llm-handler.ts`:

```typescript
// Remove these lines:
// export type EventSender = (event: Record<string, unknown>) => void;
// interface AgentSDKHandlerOptions { ... }

// Add imports:
import type { LLMHandler, LLMHandlerOptions, EventSender } from './llm-handler.js';

// Change class declaration:
export class AgentSDKHandler implements LLMHandler {
  // ... keep constructor signature but accept LLMHandlerOptions:
  constructor(opts: LLMHandlerOptions = {}) {
```

Keep the `SYSTEM_INSTRUCTIONS` and `DANGEROUS_PATTERNS` exports unchanged. Keep all method implementations unchanged. The constructor already matches — it uses optional fields from the same shape.

- [ ] **Step 2: Update imports in agent.ts and token-server.ts**

In both `src/agent.ts` and `src/token-server.ts`, add import for `EventSender` if used:

```typescript
// In agent.ts — no change needed, it imports AgentSDKHandler and SYSTEM_INSTRUCTIONS
// In token-server.ts — no change needed, it imports AgentSDKHandler
```

Verify no other files import `EventSender` or `AgentSDKHandlerOptions` from agent-sdk-handler:

Run: `grep -r "from.*agent-sdk-handler" src/`

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 4: Commit**

```bash
git add src/plugins/agent-sdk-handler.ts
git commit -m "feat: AgentSDKHandler implements LLMHandler interface"
```

---

### Task 3: Navigation Functions for OpenAI Function Calling

**Files:**
- Create: `src/plugins/nav-functions.ts`

- [ ] **Step 1: Create navigation function definitions and executor**

```typescript
// src/plugins/nav-functions.ts
import type { NavigationCommand, NavigationCallback } from '../mcp/navigation-server.js';
import type OpenAI from 'openai';

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export const navigationTools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List all available projects with descriptions.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Create a new project. Use when user says "create project X" or "new project X".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Optional project description' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_project',
      description: 'Get info about a project and its recent chats. Does NOT switch — use switch_chat or new_chat after user confirms.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project name' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_chats',
      description: 'List chats in a project. Defaults to current project if projectName not specified.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project name (default: current project)' },
          count: { type: 'number', description: 'Max number of chats to return' },
          hoursAgo: { type: 'number', description: 'Only chats from the last N hours' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_chat',
      description: 'Switch to a specific chat in a project. ONLY call after user confirms.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Target project name' },
          chatId: { type: 'string', description: 'Session ID of the chat to switch to' },
        },
        required: ['projectName', 'chatId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_chat',
      description: 'Create a new chat in a project and switch to it. ONLY call after user confirms.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Target project name' },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: 'Return to the previous project/chat. ONLY call after user confirms.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_home',
      description: 'Return to the home space (no project). ONLY call after user confirms.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_chat',
      description: 'Rename the current chat/conversation.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New name for the current chat' },
        },
        required: ['name'],
      },
    },
  },
];

/**
 * Convert an OpenAI function call to a NavigationCommand and execute it.
 * Returns the text result from the navigation handler.
 */
export async function executeNavFunction(
  functionName: string,
  args: Record<string, unknown>,
  onCommand: NavigationCallback,
): Promise<string> {
  let cmd: NavigationCommand;

  switch (functionName) {
    case 'list_projects':
      cmd = { type: 'list_projects' };
      break;
    case 'create_project':
      cmd = { type: 'create_project', name: args.name as string, description: args.description as string | undefined };
      break;
    case 'switch_project':
      cmd = { type: 'switch_project', projectName: args.projectName as string };
      break;
    case 'list_chats':
      cmd = { type: 'list_chats', projectName: args.projectName as string | undefined, count: args.count as number | undefined, hoursAgo: args.hoursAgo as number | undefined };
      break;
    case 'switch_chat':
      cmd = { type: 'switch_chat', projectName: args.projectName as string, chatId: args.chatId as string };
      break;
    case 'new_chat':
      cmd = { type: 'new_chat', projectName: args.projectName as string };
      break;
    case 'go_back':
      cmd = { type: 'go_back' };
      break;
    case 'go_home':
      cmd = { type: 'go_home' };
      break;
    case 'rename_chat':
      cmd = { type: 'rename_chat', name: args.name as string };
      break;
    default:
      return `Unknown function: ${functionName}`;
  }

  return onCommand(cmd);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/plugins/nav-functions.ts
git commit -m "feat: navigation tools as OpenAI function definitions"
```

---

### Task 4: OpenAI Chat Handler

**Files:**
- Create: `src/plugins/openai-chat-handler.ts`

- [ ] **Step 1: Create the handler**

```typescript
// src/plugins/openai-chat-handler.ts
import OpenAI from 'openai';
import type { LLMHandler, LLMHandlerOptions } from './llm-handler.js';
import { SYSTEM_INSTRUCTIONS } from './agent-sdk-handler.js';
import { navigationTools, executeNavFunction } from './nav-functions.js';
import type { NavigationCallback } from '../mcp/navigation-server.js';

interface OpenAIChatHandlerOptions extends LLMHandlerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  navigationHandler?: NavigationCallback;
}

export class OpenAIChatHandler implements LLMHandler {
  #client: OpenAI;
  #model: string;
  #onEvent: LLMHandlerOptions['onEvent'];
  #onAssistantMessage: LLMHandlerOptions['onAssistantMessage'];
  #onToolCall: LLMHandlerOptions['onToolCall'];
  #systemPrompt: string;
  #messageHistory: Array<{ role: string; text: string }>;
  #navigationHandler: NavigationCallback | null;
  #abortController: AbortController | null = null;

  constructor(opts: OpenAIChatHandlerOptions) {
    this.#client = new OpenAI({ baseURL: opts.baseUrl, apiKey: opts.apiKey });
    this.#model = opts.model;
    this.#onEvent = opts.onEvent || (() => {});
    this.#onAssistantMessage = opts.onAssistantMessage || (() => {});
    this.#onToolCall = opts.onToolCall || (() => {});
    this.#systemPrompt = opts.systemPrompt || SYSTEM_INSTRUCTIONS;
    this.#messageHistory = opts.messageHistory || [];
    this.#navigationHandler = opts.navigationHandler || null;
  }

  get sessionId(): string | null {
    return null; // No server-side session for OpenAI
  }

  async sendAndStream(
    text: string,
    onSentence: (sentence: string) => void,
    onToolCall?: () => void,
  ): Promise<void> {
    if (this.#abortController) {
      this.#abortController.abort();
    }
    this.#abortController = new AbortController();

    this.#onEvent!({ type: 'llm_send', text });
    const llmStartTime = Date.now();
    let llmFirstTokenTime: number | null = null;

    // Build messages from history
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.#systemPrompt },
      ...this.#messageHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.text,
      })),
      { role: 'user', content: text },
    ];

    let fullText = '';
    let allEmittedText = '';

    // Loop for tool call handling (model may call tools multiple times)
    while (true) {
      const stream = await this.#client.chat.completions.create(
        {
          model: this.#model,
          messages,
          stream: true,
          tools: this.#navigationHandler ? navigationTools : undefined,
        },
        { signal: this.#abortController.signal },
      );

      let currentToolCalls: Array<{ id: string; name: string; args: string }> = [];
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason || finishReason;

        // Text content
        if (delta?.content) {
          fullText += delta.content;

          const sentences = fullText.match(/[^.!?]+[.!?]+\s*/g) || [];
          const emitted = sentences.join('');
          const remainder = fullText.slice(emitted.length);

          for (const sentence of sentences) {
            if (sentence.trim()) {
              if (!llmFirstTokenTime) llmFirstTokenTime = Date.now();
              this.#onEvent!({ type: 'llm_recv', text: sentence.trim() });
              onSentence(sentence.trim());
              allEmittedText += sentence.trim() + ' ';
            }
          }
          fullText = remainder;
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (currentToolCalls.length <= tc.index) {
                currentToolCalls.push({ id: '', name: '', args: '' });
              }
              if (tc.id) currentToolCalls[tc.index].id = tc.id;
              if (tc.function?.name) currentToolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) currentToolCalls[tc.index].args += tc.function.arguments;
            }
          }
        }
      }

      // Emit remaining text
      if (fullText.trim()) {
        if (!llmFirstTokenTime) llmFirstTokenTime = Date.now();
        this.#onEvent!({ type: 'llm_recv', text: fullText.trim() });
        onSentence(fullText.trim());
        allEmittedText += fullText.trim() + ' ';
        fullText = '';
      }

      // If no tool calls, we're done
      if (finishReason !== 'tool_calls' || currentToolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: currentToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      for (const tc of currentToolCalls) {
        const args = JSON.parse(tc.args || '{}');
        const inputStr = JSON.stringify(args).slice(0, 300);
        this.#onEvent!({ type: 'tool_call', name: tc.name, input: inputStr });
        this.#onToolCall!(tc.name, inputStr);
        onToolCall?.();

        let result: string;
        if (this.#navigationHandler) {
          result = await executeNavFunction(tc.name, args, this.#navigationHandler);
        } else {
          result = `Tool ${tc.name} not available`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Continue loop — model will respond to tool results
      currentToolCalls = [];
    }

    // Save assistant message
    if (allEmittedText.trim()) {
      this.#onAssistantMessage!(allEmittedText.trim());
    }

    // Emit metrics
    const llmDuration = (llmFirstTokenTime || Date.now()) - llmStartTime;
    this.#onEvent!({
      type: 'metrics',
      llmDuration,
      llmTotalMs: Date.now() - llmStartTime,
    });
  }

  interrupt(): void {
    this.#abortController?.abort();
  }

  close(): void {
    this.interrupt();
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/plugins/openai-chat-handler.ts
git commit -m "feat: OpenAI/OpenRouter chat handler with function calling"
```

---

### Task 5: Pipeline Config Loader

**Files:**
- Create: `src/pipeline-config.ts`

- [ ] **Step 1: Create the config module**

```typescript
// src/pipeline-config.ts
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface VadConfig {
  provider: string;
  minSilenceDuration?: number;
}

export interface SttConfig {
  provider: string;
  model?: string;
  language?: string;
}

export interface TtsConfig {
  provider: string;
  model?: string;
  voice?: string;
}

export interface LlmConfig {
  provider: string;
  model: string;
}

export interface PipelineConfig {
  vad: VadConfig;
  stt: SttConfig;
  tts: TtsConfig;
  llm: LlmConfig;
}

const DEFAULTS: PipelineConfig = {
  vad: { provider: 'silero', minSilenceDuration: 1.5 },
  stt: { provider: 'deepgram', model: 'nova-3', language: 'cs' },
  tts: { provider: 'openai', model: 'tts-1', voice: 'nova' },
  llm: { provider: 'agent-sdk', model: 'claude-sonnet-4-6' },
};

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const srcVal = source[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) && typeof result[key] === 'object') {
      result[key] = deepMerge(result[key] as Record<string, unknown>, srcVal as Record<string, unknown>) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

async function loadJsonFile(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function loadPipelineConfig(
  workspaceDir: string,
  projectName?: string,
): Promise<PipelineConfig> {
  // 1. Start with defaults
  let config = { ...DEFAULTS } as PipelineConfig;

  // 2. Merge workspace-level pipeline.json
  const workspaceConfig = await loadJsonFile(path.join(workspaceDir, 'pipeline.json'));
  if (Object.keys(workspaceConfig).length > 0) {
    config = deepMerge(config, workspaceConfig as Partial<PipelineConfig>);
  }

  // 3. Merge project-level pipeline.json
  if (projectName && projectName !== '_global') {
    const projectConfig = await loadJsonFile(path.join(workspaceDir, projectName, 'pipeline.json'));
    if (Object.keys(projectConfig).length > 0) {
      config = deepMerge(config, projectConfig as Partial<PipelineConfig>);
    }
  }

  return config;
}

export { DEFAULTS as PIPELINE_DEFAULTS };
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/pipeline-config.ts
git commit -m "feat: pipeline config loader with defaults and deep merge"
```

---

### Task 6: LLM Factory

**Files:**
- Create: `src/plugins/llm-factory.ts`

- [ ] **Step 1: Create the factory**

```typescript
// src/plugins/llm-factory.ts
import type { LlmConfig } from '../pipeline-config.js';
import type { LLMHandler, LLMHandlerOptions } from './llm-handler.js';
import { AgentSDKHandler } from './agent-sdk-handler.js';
import { OpenAIChatHandler } from './openai-chat-handler.js';
import type { NavigationCallback } from '../mcp/navigation-server.js';

export interface LLMFactoryOptions extends LLMHandlerOptions {
  navigationHandler?: NavigationCallback;
  messageHistory?: Array<{ role: string; text: string }>;
}

export function createLLMHandler(
  config: LlmConfig,
  opts: LLMFactoryOptions,
): LLMHandler {
  switch (config.provider) {
    case 'agent-sdk':
      return new AgentSDKHandler({
        ...opts,
        model: config.model,
      });

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');
      return new OpenAIChatHandler({
        ...opts,
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
        model: config.model,
      });
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error('OPENROUTER_API_KEY not set in environment');
      return new OpenAIChatHandler({
        ...opts,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey,
        model: config.model,
      });
    }

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/plugins/llm-factory.ts
git commit -m "feat: LLM factory — agent-sdk, openai, openrouter"
```

---

### Task 7: Wire Pipeline Config into agent.ts

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Import pipeline config and factories**

At the top of `src/agent.ts`, add:

```typescript
import { loadPipelineConfig } from './pipeline-config.js';
import { createLLMHandler } from './plugins/llm-factory.js';
import type { LLMHandler } from './plugins/llm-handler.js';
```

- [ ] **Step 2: Load config and use it for VAD/STT/TTS**

In the `prewarm` function (line 24-28), load pipeline config and use it for VAD:

```typescript
  prewarm: async (proc: JobProcess) => {
    const workspaceDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'workspace');
    const pipelineConfig = await loadPipelineConfig(workspaceDir);
    proc.userData.pipelineConfig = pipelineConfig;
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: (pipelineConfig.vad.minSilenceDuration as number) ?? 1.5,
    });
  },
```

In the `entry` function, replace the hardcoded STT/TTS (around line 175-179):

```typescript
    const pipelineConfig = ctx.proc.userData.pipelineConfig as PipelineConfig;

    const agentSession = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: (pipelineConfig.stt.model as string) || 'nova-3',
        language: (pipelineConfig.stt.language as string) || 'cs',
      }),
      tts: new openai.TTS({
        model: (pipelineConfig.tts.model as string) || 'tts-1',
        voice: (pipelineConfig.tts.voice as string) || 'nova',
      }),
    });
```

Add the `PipelineConfig` import:

```typescript
import type { PipelineConfig } from './pipeline-config.js';
```

- [ ] **Step 3: Replace hardcoded AgentSDKHandler with factory**

Replace the initial LLM handler creation (around line 160-170). Change:

```typescript
    let claude = new AgentSDKHandler({
      model: 'claude-sonnet-4-6',
      ...
    });
```

To:

```typescript
    let claude: LLMHandler = createLLMHandler(pipelineConfig.llm, {
      cwd: initialConfig.cwd,
      systemPrompt: initialPrompt,
      mcpServers: { navigation: navServer, ...initialConfig.mcpConfig },
      additionalAllowedTools: NAVIGATION_TOOL_NAMES,
      onEvent: sendEvent,
      onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
      onAssistantMessage: (text) => handleAssistantMessage(text),
      onToolCall: (name, input) => handleToolCall(name, input),
      navigationHandler: navHandler,
      messageHistory: [],
    });
```

- [ ] **Step 4: Update context switch to use factory**

In `executePendingSwitch` (around line 128-139), replace:

```typescript
      claude = new AgentSDKHandler({
        model: 'claude-sonnet-4-6',
        ...
      });
```

With:

```typescript
      // Reload pipeline config for the new project
      const switchPipelineConfig = await loadPipelineConfig(workspaceDir, projectName);

      claude = createLLMHandler(switchPipelineConfig.llm, {
        cwd: config.cwd,
        systemPrompt: fullPrompt,
        claudeSessionId: projectCtx.currentSession?.claudeSessionId || undefined,
        mcpServers: { navigation: navServer, ...config.mcpConfig },
        additionalAllowedTools: NAVIGATION_TOOL_NAMES,
        onEvent: sendEvent,
        onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
        onAssistantMessage: (text) => handleAssistantMessage(text),
        onToolCall: (name, input) => handleToolCall(name, input),
        navigationHandler: navHandler,
        messageHistory: projectCtx.currentSession ? [] : [], // Will be loaded from session store if needed
      });
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts
git commit -m "feat: agent uses pipeline config for all processors"
```

---

### Task 8: Wire Pipeline Config into token-server.ts

**Files:**
- Modify: `src/token-server.ts`

- [ ] **Step 1: Import pipeline config and factory**

At the top of `src/token-server.ts`, add:

```typescript
import { loadPipelineConfig } from './pipeline-config.js';
import { createLLMHandler } from './plugins/llm-factory.js';
```

- [ ] **Step 2: Update SSE chat endpoint (POST /api/chat)**

In the SSE chat handler (around line 360), replace:

```typescript
  const claude = new AgentSDKHandler({
    model: 'claude-sonnet-4-6',
    ...
  });
```

With:

```typescript
  const chatPipelineConfig = await loadPipelineConfig(workspaceDir, projectName);

  // Load message history for non-Claude backends
  const history = session.messages
    ?.filter((m: SessionMessage) => m.role !== 'tool')
    .map((m: SessionMessage) => ({ role: m.role, text: m.text })) || [];

  const claude = createLLMHandler(chatPipelineConfig.llm, {
    claudeSessionId: session.claudeSessionId || undefined,
    mcpServers: { navigation: navServer },
    additionalAllowedTools: NAVIGATION_TOOL_NAMES,
    onEvent: (event) => {
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    },
    onSessionIdCaptured: async (claudeSessionId) => {
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await store.setClaudeSessionId(session.sessionId, claudeSessionId);
        console.log(`[Chat] Session ${session.sessionId} linked to Claude: ${claudeSessionId}`);
      }
    },
    onAssistantMessage: async (fullText) => {
      const assistMsg: SessionMessage = {
        role: 'assistant',
        text: fullText,
        timestamp: new Date().toISOString(),
      };
      await store.addMessage(session.sessionId, assistMsg);
    },
    onToolCall: async (name, input) => {
      const toolMsg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await store.addMessage(session.sessionId, toolMsg);
    },
    navigationHandler: navHandler,
    messageHistory: history,
  });
```

- [ ] **Step 3: Update sync chat endpoint (POST /api/projects/:name/chat)**

Apply the same pattern to the sync endpoint (around line 412). Replace `new AgentSDKHandler(...)` with `createLLMHandler(...)` using `loadPipelineConfig(workspaceDir, projectName)` and loading message history from the session.

- [ ] **Step 4: Update session name generation**

The session name generation endpoint (around line 187) uses `new AgentSDKHandler({ model: 'claude-haiku-4-5' })`. This should stay as-is — it's always Claude (subscription, no cost). No change needed.

- [ ] **Step 5: Remove direct AgentSDKHandler import if no longer needed**

Check if `AgentSDKHandler` is still used directly (for session name generation). If so, keep the import. Otherwise remove it.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 7: Commit**

```bash
git add src/token-server.ts
git commit -m "feat: token server uses pipeline config for LLM"
```

---

### Task 9: Default pipeline.json in Workspace Init

**Files:**
- Modify: `src/workspace-init.ts`

- [ ] **Step 1: Create default pipeline.json on workspace init**

In `src/workspace-init.ts`, after the `projectsPath` block (line 28-31), add:

```typescript
  const pipelinePath = path.join(workspaceDir, 'pipeline.json');
  if (!existsSync(pipelinePath)) {
    const defaultPipeline = {
      vad: { provider: 'silero', minSilenceDuration: 1.5 },
      stt: { provider: 'deepgram', model: 'nova-3', language: 'cs' },
      tts: { provider: 'openai', model: 'tts-1', voice: 'nova' },
      llm: { provider: 'agent-sdk', model: 'claude-sonnet-4-6' },
    };
    await writeFile(pipelinePath, JSON.stringify(defaultPipeline, null, 2), 'utf-8');
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Commit**

```bash
git add src/workspace-init.ts
git commit -m "feat: create default pipeline.json on workspace init"
```

---

### Task 10: Update CLAUDE.md and Test

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add a new section after the "## Permissions" section:

```markdown
## Pipeline Configuration
- `workspace/pipeline.json` — global default processor config
- `workspace/{project}/pipeline.json` — per-project override (deep merged)
- Processors: vad (silero), stt (deepgram), tts (openai), llm (agent-sdk | openai | openrouter)
- LLM providers: `agent-sdk` (full tools), `openai` (nav tools only), `openrouter` (nav tools only)
- Non-Claude backends use OpenAI function calling for navigation, local message history for session persistence
- Secrets in .env: OPENAI_API_KEY, OPENROUTER_API_KEY
- Factory in src/plugins/llm-factory.ts, config in src/pipeline-config.ts
```

- [ ] **Step 2: Build and restart**

```bash
docker compose restart agent
```

- [ ] **Step 3: Test default config (Agent SDK)**

```bash
curl -s -X POST http://localhost:3001/api/projects/_global/chat \
  -H 'Content-Type: application/json' \
  -d '{"text": "ahoj"}' | jq .
```

Expected: normal response via Agent SDK (existing behavior unchanged).

- [ ] **Step 4: Test OpenRouter config (if API key available)**

Create `workspace/test-openrouter/pipeline.json`:
```json
{ "llm": { "provider": "openrouter", "model": "openai/gpt-4o-mini" } }
```

Create the project and test. If no API key, skip this step.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: pipeline configuration in CLAUDE.md"
```
