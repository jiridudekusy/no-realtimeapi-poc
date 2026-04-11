/**
 * AgentCore — business logic extracted from the LiveKit agent.
 * No LiveKit dependency. Used by voice agent, headless endpoint, and tests.
 */
import { SYSTEM_INSTRUCTIONS } from './plugins/agent-sdk-handler.js';
import { loadPipelineConfig, type PipelineConfig } from './pipeline-config.js';
import { createLLMHandler } from './plugins/llm-factory.js';
import type { LLMHandler } from './plugins/llm-handler.js';
import { type SessionMessage, type SessionData } from './session-store.js';
import { ProjectStore } from './project-store.js';
import { ProjectContext } from './project-context.js';
import { initWorkspace } from './workspace-init.js';
import { createNavigationMcpServer, NAVIGATION_TOOL_NAMES } from './mcp/navigation-server.js';
import { createNavigationHandler } from './navigation-handler.js';

export interface AgentCoreCallbacks {
  /** Send event to client (thinking, metrics, context_switched, etc.) */
  onEvent: (event: Record<string, unknown>) => void;
  /** Speak text via TTS — per-sentence chunks (headless mode, fallback) */
  onSay: (text: string) => void;
  /** Start streaming speech — receives a ReadableStream that TTS consumes directly.
   *  If provided, sentences flow continuously into TTS instead of chunked say() calls.
   *  Voice mode: pass stream to agentSession.say(stream). */
  onSpeechStream?: (stream: ReadableStream<string>) => void;
}

export interface AgentCoreOptions {
  workspaceDir: string;
  pipelineConfig?: PipelineConfig;
  callbacks: AgentCoreCallbacks;
}

export class AgentCore {
  #workspaceDir: string;
  #pipelineConfig: PipelineConfig | null;
  #callbacks: AgentCoreCallbacks;

  #projectStore!: ProjectStore;
  #projectCtx!: ProjectContext;
  #navHandler!: (cmd: any) => Promise<string>;
  #claude!: LLMHandler;
  #processing = false;
  #pendingSwitch: { projectName: string; sessionId: string | null } | null = null;

  constructor(opts: AgentCoreOptions) {
    this.#workspaceDir = opts.workspaceDir;
    this.#pipelineConfig = opts.pipelineConfig || null;
    this.#callbacks = opts.callbacks;
  }

  get projectStore(): ProjectStore { return this.#projectStore; }
  get projectContext(): ProjectContext { return this.#projectCtx; }
  get currentProject(): string { return this.#projectCtx.currentProject; }
  get currentSession(): SessionData | null { return this.#projectCtx.currentSession; }
  get isProcessing(): boolean { return this.#processing; }

  async init(): Promise<void> {
    await initWorkspace(this.#workspaceDir);

    this.#projectStore = new ProjectStore(this.#workspaceDir);
    await this.#projectStore.init();

    this.#projectCtx = new ProjectContext(this.#projectStore, '_global');
    await this.#projectCtx.init();

    if (!this.#pipelineConfig) {
      this.#pipelineConfig = await loadPipelineConfig(this.#workspaceDir);
    }

    this.#navHandler = createNavigationHandler(
      this.#projectStore,
      this.#projectCtx,
      (projectName, sessionId) => this.#queueContextSwitch(projectName, sessionId),
    );

    await this.#buildLLMHandler(this.#pipelineConfig);
  }

  // --- LLM handler creation (async — loads project config) ---

  async #buildLLMHandler(pipelineConfig: PipelineConfig): Promise<void> {
    const config = await this.#projectCtx.loadProjectConfig();

    const projectInfo = this.#projectCtx.currentProject === '_global'
      ? 'You are in the HOME space (no project).'
      : `You are in project "${this.#projectCtx.currentProject}".`;
    const navPrompt = `${projectInfo}\nWhen switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation.`;
    const fullPrompt = [SYSTEM_INSTRUCTIONS, config.systemPrompt, navPrompt].filter(Boolean).join('\n\n');

    const navServer = createNavigationMcpServer(this.#navHandler);

    this.#claude = createLLMHandler(pipelineConfig.llm, {
      cwd: config.cwd,
      systemPrompt: fullPrompt,
      projectContext: navPrompt,
      claudeSessionId: this.#projectCtx.currentSession?.claudeSessionId || undefined,
      mcpServers: { navigation: navServer, ...config.mcpConfig },
      additionalAllowedTools: NAVIGATION_TOOL_NAMES,
      onEvent: (e) => {
        // Clear stale claudeSessionId on turn_error with resume
        if (e.event === 'turn_error' && this.#projectCtx.currentSession?.claudeSessionId) {
          console.log('[AgentCore] turn_error — clearing stale claudeSessionId');
          const session = this.#projectCtx.currentSession;
          session.claudeSessionId = null;
          this.#projectCtx.sessionStore.setClaudeSessionId(session.sessionId, null).catch(() => {});
        }
        this.#callbacks.onEvent(e);
      },
      onSessionIdCaptured: (id) => this.#handleSessionIdCaptured(id),
      onAssistantMessage: (text) => this.#handleAssistantMessage(text),
      onToolCall: (name, input) => this.#handleToolCall(name, input),
      navigationHandler: this.#navHandler,
      messageHistory: [],
    });
  }

  // --- Session management ---

  async ensureSession(): Promise<SessionData> {
    if (!this.#projectCtx.currentSession) {
      this.#projectCtx.currentSession = await this.#projectCtx.sessionStore.createSession();
      console.log(`[AgentCore] New session: ${this.#projectCtx.currentSession.sessionId}`);
      this.#callbacks.onEvent({
        type: 'session_info',
        sessionId: this.#projectCtx.currentSession.sessionId,
        projectName: this.#projectCtx.currentProject,
      });
    }
    return this.#projectCtx.currentSession;
  }

  async #handleSessionIdCaptured(claudeSessionId: string): Promise<void> {
    const session = await this.ensureSession();
    if (!session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
      await this.#projectCtx.sessionStore.setClaudeSessionId(session.sessionId, claudeSessionId);
      console.log(`[AgentCore] Session ${session.sessionId} → Claude: ${claudeSessionId}`);
    }
  }

  async #handleAssistantMessage(text: string): Promise<void> {
    const session = await this.ensureSession();
    await this.#projectCtx.sessionStore.addMessage(session.sessionId, {
      role: 'assistant', text, timestamp: new Date().toISOString(),
    });
  }

  async #handleToolCall(name: string, input: string): Promise<void> {
    const session = await this.ensureSession();
    await this.#projectCtx.sessionStore.addMessage(session.sessionId, {
      role: 'tool', text: `${name}: ${input}`, timestamp: new Date().toISOString(), name, input,
    });
  }

  // --- Context switching ---

  async #queueContextSwitch(projectName: string, sessionId: string | null): Promise<void> {
    this.#pendingSwitch = { projectName, sessionId };
    console.log(`[AgentCore] Context switch queued: ${projectName}/${sessionId || 'new'}`);
  }

  async executePendingSwitch(): Promise<void> {
    if (!this.#pendingSwitch) return;
    const { projectName, sessionId } = this.#pendingSwitch;
    this.#pendingSwitch = null;

    this.#claude.close();
    await this.#projectCtx.switchTo(projectName, sessionId || undefined);

    const switchPipelineConfig = await loadPipelineConfig(this.#workspaceDir, projectName);
    await this.#buildLLMHandler(switchPipelineConfig);

    console.log(`[AgentCore] Context switched to ${projectName}/${sessionId || 'new'}`);
    this.#callbacks.onEvent({
      type: 'context_switched',
      projectName: this.#projectCtx.currentProject,
      sessionId: this.#projectCtx.currentSession?.sessionId || null,
    });
  }

  // --- Core: process user text ---

  async processUserText(userText: string): Promise<void> {
    await this.executePendingSwitch();

    this.ensureSession().then(session => {
      return this.#projectCtx.sessionStore.addMessage(session.sessionId, {
        role: 'user', text: userText, timestamp: new Date().toISOString(),
      });
    }).catch(err => console.error('[AgentCore] Failed to persist user message:', err));

    this.#callbacks.onEvent({ type: 'thinking' });

    if (this.#processing) {
      console.log('[AgentCore] Barge-in, interrupting');
      this.#claude.interrupt();
    }
    this.#processing = true;

    // Streaming mode: create one ReadableStream per turn, TTS consumes it directly
    // Fallback mode: buffer sentences and call onSay() per chunk
    const useStreaming = !!this.#callbacks.onSpeechStream;
    let streamWriter: WritableStreamDefaultWriter<string> | null = null;
    let streamStarted = false;

    const writeSentence = (text: string) => {
      if (useStreaming) {
        if (!streamStarted) {
          // Create stream on first sentence (not on thinking/tool-only turns)
          const { readable, writable } = new TransformStream<string>();
          streamWriter = writable.getWriter();
          streamStarted = true;
          this.#callbacks.onSpeechStream!(readable);
        }
        streamWriter!.write(text).catch(() => {});
      }
      // Always call onSay too (for logging, headless text collection)
      this.#callbacks.onSay(text);
    };

    const closeStream = () => {
      if (streamWriter) {
        streamWriter.close().catch(() => {});
        streamWriter = null;
      }
    };

    // Sentence buffer (still needed to batch fast consecutive sentences)
    let buffer: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let firstSentenceAt: number | null = null;
    const COALESCE_MS = useStreaming ? 50 : 200;  // faster flush in streaming mode
    const MAX_WAIT_MS = useStreaming ? 500 : 1500;

    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (buffer.length === 0) return;
      const text = buffer.join(' ');
      buffer = [];
      firstSentenceAt = null;
      writeSentence(text);
    };

    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      const elapsed = firstSentenceAt ? Date.now() - firstSentenceAt : 0;
      const remaining = Math.max(0, MAX_WAIT_MS - elapsed);
      flushTimer = setTimeout(flush, Math.min(COALESCE_MS, remaining));
    };

    try {
      await this.#claude.sendAndStream(userText, (sentence) => {
        if (firstSentenceAt === null) firstSentenceAt = Date.now();
        buffer.push(sentence);
        scheduleFlush();
      }, () => {
        flush(); // tool call — flush pending text before tool runs
      });
      flush();
    } catch (err) {
      console.error('[AgentCore] LLM error:', err);
      this.#callbacks.onEvent({ type: 'agent_sdk', event: 'error', error: String(err) });
    } finally {
      closeStream();
      this.#processing = false;
      await this.executePendingSwitch();
    }
  }

  // --- Client commands ---

  async handleSessionInit(projectName: string, sessionId?: string): Promise<void> {
    await this.#queueContextSwitch(projectName, sessionId || null);
  }

  interrupt(): void {
    this.#claude.interrupt();
  }

  close(): void {
    this.#claude.close();
  }
}
