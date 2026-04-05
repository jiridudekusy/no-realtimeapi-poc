import {
  unstable_v2_createSession,
  type SDKSession,
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
- Spell out numbers and abbreviations when needed for clarity
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
  #session: SDKSession | null = null;
  #firstTurn = true;
  #abortController: AbortController | null = null;
  #pendingResults = 0;
  #queue: Promise<void> = Promise.resolve(); // Serializes sends

  constructor(opts: AgentSDKHandlerOptions = {}) {
    this.#model = opts.model || 'claude-sonnet-4-6';
    this.#onEvent = opts.onEvent || (() => {});
  }

  #ensureSession(): SDKSession {
    if (this.#session) return this.#session;

    const canUseTool: CanUseTool = async (
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

    this.#session = unstable_v2_createSession({
      model: this.#model,
      permissionMode: 'bypassPermissions',
      canUseTool,
    });
    this.#firstTurn = true;
    this.#pendingResults = 0;
    console.log(`[AgentSDK] Session created (${this.#model})`);
    this.#onEvent({ type: 'agent_sdk', event: 'session_created' });
    return this.#session;
  }

  async sendAndStream(
    userText: string,
    onSentence: (sentence: string) => void,
  ): Promise<void> {
    // Serialize: wait for previous turn to finish before sending
    const prev = this.#queue;
    let resolve: () => void;
    this.#queue = new Promise<void>((r) => { resolve = r; });
    await prev;

    try {
      await this.#doSendAndStream(userText, onSentence);
    } finally {
      resolve!();
    }
  }

  async #doSendAndStream(
    userText: string,
    onSentence: (sentence: string) => void,
  ): Promise<void> {
    const session = this.#ensureSession();

    let text = userText;
    if (this.#firstTurn) {
      this.#firstTurn = false;
      text = `${SYSTEM_INSTRUCTIONS}\n\nUser: ${userText}`;
    }

    this.#abortController?.abort();
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    console.log(`[AgentSDK] Sending: ${text.slice(0, 200)}...`);
    this.#onEvent({ type: 'llm_send', text: userText });
    await session.send(text);

    // Get fresh iterator for this turn
    const iter = session.stream() as AsyncGenerator<SDKMessage>;

    // Skip any pending results from previous turns that weren't consumed
    let skipped = 0;
    while (this.#pendingResults > 0) {
      const { value, done } = await iter.next();
      if (done) break;
      const msg = value as any;
      console.log(`[AgentSDK] Skipping old msg: type=${msg.type}`);
      if (msg.type === 'result') {
        this.#pendingResults--;
        skipped++;
      }
    }
    if (skipped > 0) console.log(`[AgentSDK] Skipped ${skipped} old results`);

    let fullText = '';
    let gotAssistant = false;

    for await (const message of iter) {
      if (signal.aborted) {
        console.log('[AgentSDK] Aborted');
        this.#pendingResults++; // This turn's result will be pending
        break;
      }

      const msg = message as any;

      if (msg.type === 'assistant' && msg.message?.content) {
        gotAssistant = true;
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            console.log(`[AgentSDK] Text (${block.text.length}ch): ${block.text.slice(0, 80)}`);
            fullText += block.text;

            const sentences = fullText.match(/[^.!?]+[.!?]+\s*/g) || [];
            const emitted = sentences.join('');
            const remainder = fullText.slice(emitted.length);

            for (const sentence of sentences) {
              if (sentence.trim() && !signal.aborted) {
                this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                onSentence(sentence.trim());
              }
            }
            fullText = remainder;
          }
        }
      } else if (msg.type === 'result') {
        // If we got a result without any assistant message, it might be from a previous turn
        if (!gotAssistant) {
          console.log('[AgentSDK] Got orphaned result (no assistant msg), skipping');
          continue; // Keep reading for the real response
        }

        if (fullText.trim() && !signal.aborted) {
          this.#onEvent({ type: 'llm_recv', text: fullText.trim() });
          onSentence(fullText.trim());
        }
        fullText = '';

        if (msg.subtype === 'success') {
          this.#onEvent({ type: 'agent_sdk', event: 'turn_complete', cost: msg.total_cost_usd, usage: msg.usage });
        } else {
          console.error(`[AgentSDK] Turn error: ${msg.subtype}`);
          this.#onEvent({ type: 'agent_sdk', event: 'turn_error', error: msg.subtype });
        }
        break;
      }
    }
  }

  abort(): void {
    this.#abortController?.abort();
    this.#pendingResults++;
  }

  close(): void {
    try { this.#session?.close(); } catch {}
    this.#session = null;
  }
}
