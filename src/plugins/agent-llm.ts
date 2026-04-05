import { llm } from '@livekit/agents';
import {
  unstable_v2_createSession,
  type SDKSession,
  type SDKMessage,
  type CanUseTool,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

export type EventSender = (event: Record<string, unknown>) => void;

interface APIConnectOptions {
  maxRetry: number;
  retryIntervalMs: number;
  timeoutMs: number;
}

interface AgentLLMOptions {
  model?: string;
  onEvent?: EventSender;
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /sudo\b/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  />\s*\/dev\//i,
  /chmod\s+777/i,
  /curl.*\|\s*bash/i,
  /wget.*\|\s*bash/i,
];

const SYSTEM_INSTRUCTIONS = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Use plain conversational language without markdown formatting
- Do not use bullet points, asterisks, pound signs, or other markdown
- Keep responses concise and natural-sounding
- Spell out numbers and abbreviations when needed for clarity
- Avoid code blocks; describe code changes in plain language`;

/**
 * Custom LLM plugin that wraps the Claude Agent SDK v2 session.
 * Maintains a persistent session for multi-turn conversations.
 */
export class AgentLLM extends llm.LLM {
  #model: string;
  #onEvent: EventSender;
  #session: SDKSession | null = null;
  #sessionDead = false;

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

  getOrCreateSession(): SDKSession {
    if (this.#session && !this.#sessionDead) {
      return this.#session;
    }

    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      _options,
    ): Promise<PermissionResult> => {
      const inputStr = JSON.stringify(input);
      const isDangerous = DANGEROUS_PATTERNS.some((pattern) => pattern.test(inputStr));

      console.log(`[AgentLLM] Tool request: ${toolName}(${inputStr})`);
      this.#onEvent({ type: 'tool_request', name: toolName, input });

      if (isDangerous) {
        console.warn(`[AgentLLM] Blocked dangerous tool call: ${toolName}(${inputStr})`);
        this.#onEvent({ type: 'tool_blocked', name: toolName, input });
        return { behavior: 'deny', message: 'Dangerous command pattern detected and blocked.' };
      }

      return { behavior: 'allow' };
    };

    this.#session = unstable_v2_createSession({
      model: this.#model,
      permissionMode: 'acceptEdits',
      canUseTool,
    });
    this.#sessionDead = false;
    console.log(`[AgentLLM] Created new session with model ${this.#model}`);
    return this.#session;
  }

  markSessionDead(): void {
    this.#sessionDead = true;
    this.#session = null;
  }

  chat(opts: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new AgentLLMStream(this, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions ?? { maxRetry: 3, retryIntervalMs: 2000, timeoutMs: 60000 },
      onEvent: this.#onEvent,
    });
  }
}

class AgentLLMStream extends llm.LLMStream {
  #agentLLM: AgentLLM;
  #onEvent: EventSender;
  #isFirstMessage = true;

  constructor(
    agentLLM: AgentLLM,
    opts: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      onEvent: EventSender;
    },
  ) {
    super(agentLLM, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions,
    });
    this.#agentLLM = agentLLM;
    this.#onEvent = opts.onEvent;
  }

  /**
   * Extract the last user message text from the chat context.
   */
  private extractUserText(): string {
    const items = this.chatCtx.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      // Only process ChatMessage items with role 'user'
      if (item.type !== 'message' || item.role !== 'user') continue;
      const parts: string[] = [];
      for (const content of item.content) {
        if (typeof content === 'string') {
          parts.push(content);
        } else if (content.type === 'audio_content' && content.transcript) {
          parts.push(content.transcript);
        }
      }
      if (parts.length > 0) return parts.join(' ');
    }
    return '';
  }

  protected async run(): Promise<void> {
    let userText = this.extractUserText();
    if (!userText) {
      console.warn('[AgentLLM] No user text found in chat context, skipping.');
      return;
    }

    // Prepend system instructions on the first message
    if (this.#isFirstMessage) {
      userText = `${SYSTEM_INSTRUCTIONS}\n\n${userText}`;
      this.#isFirstMessage = false;
    }

    let session: SDKSession;
    try {
      session = this.#agentLLM.getOrCreateSession();
    } catch (err) {
      console.error('[AgentLLM] Failed to create session:', err);
      throw err;
    }

    try {
      await session.send(userText);
    } catch (err) {
      console.error('[AgentLLM] Failed to send message to session:', err);
      this.#agentLLM.markSessionDead();
      throw err;
    }

    const chunkId = `agent-${Date.now()}`;
    let hasError = false;

    try {
      for await (const message of session.stream()) {
        if (this.abortController.signal.aborted) return;

        const sdkMsg = message as SDKMessage;

        if (sdkMsg.type === 'stream_event') {
          // SDKPartialAssistantMessage — contains streaming text deltas
          const event = sdkMsg.event;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const text = event.delta.text;
            if (text) {
              this.queue.put({
                id: chunkId,
                delta: { role: 'assistant', content: text },
              });
            }
          }
        } else if (sdkMsg.type === 'assistant') {
          // SDKAssistantMessage — full assistant message, check for errors
          if (sdkMsg.error) {
            console.error(`[AgentLLM] Assistant message error: ${sdkMsg.error}`);
            this.#onEvent({ type: 'agent_error', error: sdkMsg.error });
            hasError = true;
          }
        } else if (sdkMsg.type === 'result') {
          // SDKResultMessage — end of turn, emit usage
          const usage = sdkMsg.usage;
          if (usage) {
            this.queue.put({
              id: chunkId,
              usage: {
                completionTokens: usage.output_tokens ?? 0,
                promptTokens: usage.input_tokens ?? 0,
                promptCachedTokens: 0,
                totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
              },
            });
          }
          if (sdkMsg.subtype === 'error_during_execution' || sdkMsg.subtype === 'error_max_turns') {
            console.error(`[AgentLLM] Session ended with error: ${sdkMsg.subtype}`);
            this.#onEvent({ type: 'session_error', subtype: sdkMsg.subtype });
            hasError = true;
          }
          // Result marks end of the agent's response for this turn
          break;
        } else if (sdkMsg.type === 'system') {
          // Log session state changes
          if (sdkMsg.subtype === 'session_state_changed') {
            console.log(`[AgentLLM] Session state: ${(sdkMsg as { state: string }).state}`);
          }
        }
      }
    } catch (err) {
      console.error('[AgentLLM] Error streaming from session:', err);
      this.#agentLLM.markSessionDead();
      throw err;
    }

    if (hasError) {
      // Mark session dead so next call creates a fresh one
      this.#agentLLM.markSessionDead();
    }
  }
}
