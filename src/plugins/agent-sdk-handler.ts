import {
  query,
  type Query,
  type SDKMessage,
  type CanUseTool,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

export type EventSender = (event: Record<string, unknown>) => void;

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
- Keep responses concise — two to three sentences max unless the user asks for detail
- NEVER write digits or numerals — always spell out every number as words: "třicet dva tisíc" not "32000", "devět celých sedm osm" not "9.78"
- NEVER write units as symbols — always spell them out: "kilogramů" not "kg", "stupňů Celsia" not "°C", "procent" not "%", "metrů" not "m"
- Spell out acronyms letter by letter with spaces: "A P I" not "API", "H T T P" not "HTTP"
- Avoid code blocks; describe code changes in plain language
- You have full access to bash, file system, and the internet via curl
- Respond in the language the user speaks (Czech or English)`;

interface AgentSDKHandlerOptions {
  model?: string;
  onEvent?: EventSender;
}

export class AgentSDKHandler {
  #model: string;
  #onEvent: EventSender;
  #sessionId: string | null = null;
  #currentQuery: Query | null = null;
  #abortController: AbortController | null = null;

  constructor(opts: AgentSDKHandlerOptions = {}) {
    this.#model = opts.model || 'claude-sonnet-4-6';
    this.#onEvent = opts.onEvent || (() => {});
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

    const q = query({
      prompt: userText,
      options: {
        model: this.#model,
        systemPrompt: SYSTEM_INSTRUCTIONS,
        abortController: this.#abortController,
        permissionMode: 'default',
        canUseTool: this.#makeCanUseTool(),
        mcpServers: {},
        extraArgs: { 'strict-mcp-config': null }, // Ignore all user/project MCP configs
        ...(this.#sessionId ? { resume: this.#sessionId } : {}),
      },
    });
    this.#currentQuery = q;

    let fullText = '';

    try {
      for await (const message of q) {
        const msg = message as any;

        // Capture sessionId from any message that has it
        if (msg.session_id && !this.#sessionId) {
          this.#sessionId = msg.session_id;
          console.log(`[AgentSDK] Session ID captured: ${this.#sessionId}`);
        }
        if (msg.sessionId && !this.#sessionId) {
          this.#sessionId = msg.sessionId;
          console.log(`[AgentSDK] Session ID captured: ${this.#sessionId}`);
        }

        // Capture sessionId from result
        if (msg.type === 'result') {
          if (msg.sessionId) {
            this.#sessionId = msg.sessionId;
          }

          // Emit remaining text
          if (fullText.trim()) {
            this.#onEvent({ type: 'llm_recv', text: fullText.trim() });
            onSentence(fullText.trim());
            fullText = '';
          }

          if (msg.subtype === 'success') {
            this.#onEvent({ type: 'agent_sdk', event: 'turn_complete', cost: msg.total_cost_usd, result: msg.result?.slice(0, 100) });
          } else {
            console.error(`[AgentSDK] Turn error: ${msg.subtype}`);
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
                this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                onSentence(sentence.trim());
              }
            }
            fullText = remainder;
          }
        }

        // Log tool use from assistant messages (Bash, Read, Write, etc.)
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              const input = block.input || {};
              const cmd = input.command || input.file_path || input.pattern || JSON.stringify(input);
              const inputStr = typeof cmd === 'string' ? cmd.slice(0, 300) : JSON.stringify(cmd).slice(0, 300);
              console.log(`[AgentSDK] Tool call: ${block.name}: ${inputStr.slice(0, 100)}`);
              this.#onEvent({ type: 'tool_call', name: block.name, input: inputStr });
            }
          }
        }

        // Full assistant message text (fallback if no streaming)
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
                  this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                  onSentence(sentence.trim());
                }
              }
              fullText = remainder;
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
