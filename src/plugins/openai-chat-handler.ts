// src/plugins/openai-chat-handler.ts
// OpenAI/OpenRouter chat handler with function calling for navigation tools.

import OpenAI from 'openai';
import type { LLMHandler, LLMHandlerOptions, NavigationCallback } from './llm-handler.js';
import { navigationTools, executeNavFunction } from './nav-functions.js';

const OPENAI_SYSTEM_INSTRUCTIONS = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Use plain conversational language without markdown formatting
- Do not use bullet points, asterisks, pound signs, or other markdown
- Keep responses concise — two to three sentences max unless the user asks for detail
- NEVER write digits or numerals — always spell out every number as words
- NEVER write units as symbols — always spell them out
- Spell out acronyms letter by letter with spaces
- Avoid code blocks; describe things in plain language
- Respond in the language the user speaks (Czech or English)
- You do NOT have access to the internet, file system, bash, or any external tools
- If asked to do something requiring internet or file access, explain that you cannot do that

NAVIGATION TOOLS — you MUST use these when the user wants to manage projects or chats:
- list_projects: Call this immediately when user asks about available projects. Do NOT just talk about it — call the tool.
- create_project: Create a new project when user asks.
- switch_project: Get info about a project and its chats. Call this before switching.
- list_chats: List conversations in a project. Call this when user asks what chats exist.
- switch_chat: Switch to a specific chat. Call after user confirms.
- new_chat: Start a new conversation in a project.
- go_back / go_home: Navigate back or to home.
- rename_chat: Rename current conversation.

IMPORTANT: When the user asks you to do something with projects or chats, CALL THE TOOL IMMEDIATELY. Do not ask "should I do it?" — just do it. Only confirm before destructive actions like switching away from current context.`;

export interface OpenAIChatHandlerOptions extends LLMHandlerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAIChatHandler implements LLMHandler {
  #client: OpenAI;
  #model: string;
  #systemPrompt: string;
  #navigationHandler: NavigationCallback | undefined;
  #onEvent: NonNullable<LLMHandlerOptions['onEvent']>;
  #onAssistantMessage: NonNullable<LLMHandlerOptions['onAssistantMessage']>;
  #onToolCall: NonNullable<LLMHandlerOptions['onToolCall']>;
  #messageHistory: Array<{ role: string; text: string }>;
  #abortController: AbortController | null = null;

  constructor(opts: OpenAIChatHandlerOptions) {
    this.#client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
    });
    this.#model = opts.model;
    // Always use our own base prompt — ignore opts.systemPrompt which contains
    // Agent SDK instructions referencing tools we don't have (bash, file system, etc.)
    // Append project context if provided (e.g. "You are in project X")
    this.#systemPrompt = opts.projectContext
      ? OPENAI_SYSTEM_INSTRUCTIONS + '\n\n' + opts.projectContext
      : OPENAI_SYSTEM_INSTRUCTIONS;
    this.#navigationHandler = opts.navigationHandler;
    this.#onEvent = opts.onEvent ?? (() => {});
    this.#onAssistantMessage = opts.onAssistantMessage ?? (() => {});
    this.#onToolCall = opts.onToolCall ?? (() => {});
    this.#messageHistory = opts.messageHistory ?? [];
  }

  get sessionId(): string | null {
    return null;
  }

  async sendAndStream(
    text: string,
    onSentence: (sentence: string) => void,
    onToolCall?: () => void,
  ): Promise<void> {
    // Abort any previous request
    if (this.#abortController) {
      this.#abortController.abort();
    }
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    // Build initial message list from accumulated history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.#systemPrompt },
      ...this.#messageHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.text,
      })),
      { role: 'user', content: text },
    ];

    this.#onEvent({ type: 'llm_send', text });
    const llmStartTime = Date.now();
    let llmFirstTokenTime: number | null = null;

    let fullResponse = '';

    const MAX_TOOL_ROUNDS = 5;
    let toolRound = 0;

    try {
      // Tool call loop — model may call multiple rounds of tools before giving final response
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tools = this.#navigationHandler ? navigationTools : undefined;

        const stream = await this.#client.chat.completions.create(
          {
            model: this.#model,
            messages,
            stream: true,
            ...(tools ? { tools } : {}),
          },
          { signal },
        );

        // Accumulated state for this streaming round
        let roundText = '';
        let finishReason: string | null = null;

        // Tool call accumulation: index → { id, name, args }
        const pendingToolCalls: Record<number, { id: string; name: string; args: string }> = {};

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          finishReason = choice.finish_reason ?? finishReason;

          const delta = choice.delta;

          // Text delta
          if (delta.content) {
            roundText += delta.content;

            if (!llmFirstTokenTime) {
              llmFirstTokenTime = Date.now();
            }

            // Emit complete sentences as they accumulate
            const sentences = roundText.match(/[^.!?]+[.!?]+\s*/g) ?? [];
            const emitted = sentences.join('');
            const remainder = roundText.slice(emitted.length);

            for (const sentence of sentences) {
              if (sentence.trim()) {
                this.#onEvent({ type: 'llm_recv', text: sentence.trim() });
                onSentence(sentence.trim());
                fullResponse += sentence.trim() + ' ';
              }
            }
            roundText = remainder;
          }

          // Accumulate tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!pendingToolCalls[idx]) {
                pendingToolCalls[idx] = { id: '', name: '', args: '' };
              }
              if (tc.id) pendingToolCalls[idx].id += tc.id;
              if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
              if (tc.function?.arguments) pendingToolCalls[idx].args += tc.function.arguments;
            }
          }
        }

        // Flush any remaining text (no trailing punctuation)
        if (roundText.trim()) {
          if (!llmFirstTokenTime) {
            llmFirstTokenTime = Date.now();
          }
          this.#onEvent({ type: 'llm_recv', text: roundText.trim() });
          onSentence(roundText.trim());
          fullResponse += roundText.trim() + ' ';
          roundText = '';
        }

        // If the model finished with tool calls, execute them and loop
        if (finishReason === 'tool_calls' && this.#navigationHandler) {
          toolRound++;
          if (toolRound > MAX_TOOL_ROUNDS) {
            console.log(`[OpenAIChat] Max tool rounds (${MAX_TOOL_ROUNDS}) reached, stopping`);
            break;
          }

          const toolCallList = Object.values(pendingToolCalls);

          if (toolCallList.length === 0) break;

          // Add assistant message with tool_calls to history
          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            tool_calls: toolCallList.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.args },
            })),
          };
          messages.push(assistantMsg);

          // Execute each tool call and collect results
          for (const tc of toolCallList) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.args || '{}');
            } catch {
              args = {};
            }

            console.log(`[OpenAIChat] Tool call: ${tc.name}(${JSON.stringify(args).slice(0, 100)})`);
            this.#onEvent({ type: 'tool_call', name: tc.name, input: JSON.stringify(args).slice(0, 300) });
            onToolCall?.();
            this.#onToolCall(tc.name, JSON.stringify(args).slice(0, 300));

            let result: string;
            try {
              result = await executeNavFunction(tc.name, args, this.#navigationHandler);
            } catch (err) {
              result = `Error: ${String(err)}`;
            }

            console.log(`[OpenAIChat] Tool result: ${result.slice(0, 100)}`);

            const toolResultMsg: OpenAI.ChatCompletionToolMessageParam = {
              role: 'tool',
              tool_call_id: tc.id,
              content: result,
            };
            messages.push(toolResultMsg);
          }

          // Loop back to get model's response after tool execution
          continue;
        }

        // Normal finish — exit loop
        break;
      }

      // Emit full assembled response and accumulate history for next turn
      if (fullResponse.trim()) {
        this.#onAssistantMessage(fullResponse.trim());
      }
      this.#messageHistory.push({ role: 'user', text });
      if (fullResponse.trim()) {
        this.#messageHistory.push({ role: 'assistant', text: fullResponse.trim() });
      }

      // Emit timing metrics
      const llmDuration = (llmFirstTokenTime ?? Date.now()) - llmStartTime;
      this.#onEvent({
        type: 'metrics',
        llmDuration,
        llmTotalMs: Date.now() - llmStartTime,
      });
    } catch (err: unknown) {
      const e = err as { name?: string };
      if (e?.name === 'AbortError' || this.#abortController?.signal.aborted) {
        console.log('[OpenAIChat] Request aborted (barge-in)');
        this.#onEvent({ type: 'openai_chat', event: 'interrupted' });
      } else {
        console.error('[OpenAIChat] Error:', err);
        this.#onEvent({ type: 'openai_chat', event: 'error', error: String(err) });
        throw err;
      }
    } finally {
      this.#abortController = null;
    }
  }

  interrupt(): void {
    this.#abortController?.abort();
  }

  close(): void {
    this.interrupt();
  }
}
