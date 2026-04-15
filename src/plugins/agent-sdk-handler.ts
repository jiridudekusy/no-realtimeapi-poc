import {
  query,
  type Query,
  type SDKMessage,
  type CanUseTool,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { LLMHandler, LLMHandlerOptions, EventSender } from './llm-handler.js';

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

export const SYSTEM_INSTRUCTIONS = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Use plain conversational language without markdown formatting
- Do not use bullet points, asterisks, pound signs, or other markdown
- Keep responses concise — two to three sentences max unless the user asks for detail
- NEVER write digits or numerals — always spell out every number as words: "třicet dva tisíc" not "32000", "devět celých sedm osm" not "9.78"
- NEVER write units as symbols — always spell them out: "kilogramů" not "kg", "stupňů Celsia" not "°C", "procent" not "%", "metrů" not "m"
- Spell out acronyms letter by letter with spaces: "A P I" not "API", "H T T P" not "HTTP"
- Avoid code blocks; describe code changes in plain language
- You have full access to bash, file system, and the internet via curl
- Respond in the language the user speaks (Czech or English)
- IMPORTANT: When you need to use a tool (bash, curl, file operations), ALWAYS first say a short sentence about what you are going to do BEFORE calling the tool. For example: "Podívám se na aktuální počasí." then call curl. This way the user hears feedback immediately while the tool runs.`;

export class AgentSDKHandler implements LLMHandler {
  #model: string;
  #onEvent: EventSender;
  #sessionId: string | null = null;
  #currentQuery: Query | null = null;
  #abortController: AbortController | null = null;
  #onAssistantMessage: (text: string) => void;
  #onToolCall: (name: string, input: string) => void;
  #onSessionIdCaptured: (claudeSessionId: string) => void;
  #mcpServers: Record<string, unknown>;
  #additionalAllowedTools: string[];
  #cwd: string | undefined;
  #systemPrompt: string | undefined;

  constructor(opts: LLMHandlerOptions = {}) {
    this.#model = opts.model || 'claude-sonnet-4-6';
    this.#onEvent = opts.onEvent || (() => {});
    this.#sessionId = opts.claudeSessionId || null;
    this.#onAssistantMessage = opts.onAssistantMessage || (() => {});
    this.#onToolCall = opts.onToolCall || (() => {});
    this.#onSessionIdCaptured = opts.onSessionIdCaptured || (() => {});
    this.#mcpServers = opts.mcpServers || {};
    this.#additionalAllowedTools = opts.additionalAllowedTools || [];
    this.#cwd = opts.cwd;
    this.#systemPrompt = opts.systemPrompt;
  }

  get claudeSessionId(): string | null {
    return this.#sessionId;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  #makeCanUseTool(): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const inputStr = JSON.stringify(input).slice(0, 300);
      console.log(`[AgentSDK] Tool: ${toolName}(${inputStr.slice(0, 100)})`);
      this.#onEvent({ type: 'tool_use', tool: toolName, input: inputStr });

      if (DANGEROUS_PATTERNS.some((p) => p.test(inputStr))) {
        this.#onEvent({ type: 'tool_denied', tool: toolName, reason: 'dangerous pattern' });
        return { behavior: 'deny', message: 'Dangerous command blocked.' };
      }
      return { behavior: 'allow' };
    };
  }

  /**
   * Send user text to Claude via query() API.
   * Each call is a self-contained query with clean lifecycle.
   * Uses resume to maintain conversation history across turns.
   */
  async sendAndStream(
    userText: string,
    onSentence: (sentence: string) => void,
    onToolCall?: () => void,
  ): Promise<void> {
    // Abort previous query if still running
    if (this.#abortController) {
      console.log('[AgentSDK] Interrupting previous query');
      this.#abortController.abort();
    }

    this.#abortController = new AbortController();

    const isFirst = !this.#sessionId;
    if (isFirst) {
      this.#onEvent({ type: 'agent_sdk', event: 'session_created' });
    }

    console.log(`[AgentSDK] Query: ${userText.slice(0, 80)}... (session=${this.#sessionId || 'new'})`);
    this.#onEvent({ type: 'llm_send', text: userText });
    const llmStartTime = Date.now();
    let llmFirstTokenTime: number | null = null;

    const q = query({
      prompt: userText,
      options: {
        model: this.#model,
        systemPrompt: this.#systemPrompt || SYSTEM_INSTRUCTIONS,
        abortController: this.#abortController,
        permissionMode: 'default',
        allowedTools: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ToolSearch',
          ...this.#additionalAllowedTools,
        ],
        // Bash NOT in allowedTools — goes through canUseTool for dangerous pattern check
        canUseTool: this.#makeCanUseTool(),
        mcpServers: this.#mcpServers as any,
        extraArgs: { 'strict-mcp-config': null },
        ...(this.#cwd ? { cwd: this.#cwd } : {}),
        ...(this.#sessionId ? { resume: this.#sessionId } : {}),
      },
    });
    this.#currentQuery = q;

    let fullText = '';
    let allEmittedText = '';

    try {
      for await (const message of q) {
        const msg = message as any;

        // Capture sessionId from any message that has it
        if (msg.session_id && !this.#sessionId) {
          this.#sessionId = msg.session_id;
          console.log(`[AgentSDK] Session ID captured: ${this.#sessionId}`);
          this.#onSessionIdCaptured(msg.session_id as string);
        }
        if (msg.sessionId && !this.#sessionId) {
          this.#sessionId = msg.sessionId;
          console.log(`[AgentSDK] Session ID captured: ${this.#sessionId}`);
          this.#onSessionIdCaptured(msg.sessionId as string);
        }

        // Capture sessionId from result
        if (msg.type === 'result') {
          if (msg.sessionId) {
            this.#sessionId = msg.sessionId;
          }

          // Emit remaining text
          if (fullText.trim()) {
            if (!llmFirstTokenTime) {
              llmFirstTokenTime = Date.now();
            }
            this.#onEvent({ type: 'llm_recv', text: fullText.trim() });
            onSentence(fullText.trim());
            allEmittedText += fullText.trim() + ' ';
            fullText = '';
          }

          if (allEmittedText.trim()) {
            this.#onAssistantMessage(allEmittedText.trim());
          }

          // Send LLM timing
          const llmDuration = (llmFirstTokenTime || Date.now()) - llmStartTime;
          this.#onEvent({
            type: 'metrics',
            llmDuration,
            llmTotalMs: Date.now() - llmStartTime,
          });

          if (msg.subtype === 'success') {
            this.#onEvent({ type: 'agent_sdk', event: 'turn_complete', cost: msg.total_cost_usd, result: msg.result?.slice(0, 100) });
          } else if (this.#sessionId) {
            // Turn error with resume — might be stale/incompatible session.
            // Clear sessionId so next call starts fresh.
            const errorDetail = msg.error || msg.result || msg.subtype;
            console.error(`[AgentSDK] Turn error with resume (${this.#sessionId}): ${msg.subtype}`, String(errorDetail).slice(0, 200));
            console.log('[AgentSDK] Clearing sessionId — next call will start fresh');
            this.#sessionId = null;
            this.#onEvent({ type: 'agent_sdk', event: 'turn_error', error: `${msg.subtype} (will retry without resume)` });
          } else {
            const errorDetail = msg.error || msg.result || msg.subtype;
            console.error(`[AgentSDK] Turn error: ${msg.subtype}`, String(errorDetail).slice(0, 200));
            this.#onEvent({ type: 'agent_sdk', event: 'turn_error', error: msg.subtype });
          }
          break;
        }

        // Streaming text deltas
        if (msg.type === 'stream_event') {
          const evt = msg.event;
          if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            fullText += evt.delta.text;

            // Emit complete sentences
            const sentences = fullText.match(/[^.!?]+[.!?]+\s*/g) || [];
            const emitted = sentences.join('');
            const remainder = fullText.slice(emitted.length);

            for (const sentence of sentences) {
              if (sentence.trim()) {
                if (!llmFirstTokenTime) {
                  llmFirstTokenTime = Date.now();
                }
                this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                onSentence(sentence.trim());
                allEmittedText += sentence.trim() + ' ';
              }
            }
            fullText = remainder;
          }
        }

        // Process assistant message content blocks in order:
        // text → buffer + sentence split, tool_use → flush buffer then log
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              console.log(`[AgentSDK] Text (${block.text.length}ch): ${block.text.slice(0, 80)}`);
              fullText += block.text;

              const sentences = fullText.match(/[^.!?]+[.!?]+\s*/g) || [];
              const emitted = sentences.join('');
              const remainder = fullText.slice(emitted.length);

              for (const sentence of sentences) {
                if (sentence.trim()) {
                  if (!llmFirstTokenTime) {
                    llmFirstTokenTime = Date.now();
                  }
                  this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                  onSentence(sentence.trim());
                  allEmittedText += sentence.trim() + ' ';
                }
              }
              fullText = remainder;
            }

            if (block.type === 'tool_use') {
              // Flush buffered text before tool executes
              if (fullText.trim()) {
                if (!llmFirstTokenTime) {
                  llmFirstTokenTime = Date.now();
                }
                this.#onEvent({ type: 'llm_recv', text: fullText.trim() });
                onSentence(fullText.trim());
                allEmittedText += fullText.trim() + ' ';
                fullText = '';
              }
              const input = block.input || {};
              const cmd = input.command || input.file_path || input.pattern || JSON.stringify(input);
              const inputStr = typeof cmd === 'string' ? cmd.slice(0, 300) : JSON.stringify(cmd).slice(0, 300);
              console.log(`[AgentSDK] Tool call: ${block.name}: ${inputStr.slice(0, 100)}`);
              this.#onEvent({ type: 'tool_call', name: block.name, input: inputStr });
              onToolCall?.();
              this.#onToolCall(block.name, inputStr);
            }
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || this.#abortController?.signal.aborted) {
        console.log('[AgentSDK] Query aborted (barge-in)');
        this.#onEvent({ type: 'agent_sdk', event: 'interrupted' });
      } else {
        console.error('[AgentSDK] Query error:', err);
        this.#onEvent({ type: 'agent_sdk', event: 'error', error: String(err) });
        throw err;
      }
    } finally {
      this.#currentQuery = null;
    }
  }

  /** Interrupt current query (barge-in / Ctrl+C equivalent). */
  interrupt(): void {
    if (this.#currentQuery) {
      console.log('[AgentSDK] Interrupting via query.interrupt()');
      this.#currentQuery.interrupt().catch(() => {});
    }
    this.#abortController?.abort();
  }

  close(): void {
    this.interrupt();
    this.#sessionId = null;
  }
}
