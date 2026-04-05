import { llm } from '@livekit/agents';
import OpenAI from 'openai';
import { toolDefinitions, executeTool } from './tools.js';

export type EventSender = (event: Record<string, unknown>) => void;

interface ToolLLMOptions {
  model?: string;
  apiKey?: string;
  maxToolRounds?: number;
  onEvent?: EventSender;
}

/**
 * Custom LLM plugin that wraps OpenAI API with tool calling support.
 * When the LLM returns a tool call, this plugin executes the tool,
 * feeds the result back, and streams the final response.
 */
export class ToolLLM extends llm.LLM {
  #client: OpenAI;
  #model: string;
  #maxToolRounds: number;
  #onEvent: EventSender;

  constructor(opts: ToolLLMOptions = {}) {
    super();
    this.#client = new OpenAI({ apiKey: opts.apiKey || process.env.OPENAI_API_KEY });
    this.#model = opts.model || 'gpt-4o-mini';
    this.#maxToolRounds = opts.maxToolRounds || 5;
    this.#onEvent = opts.onEvent || (() => {});
  }

  label(): string {
    return 'tool-llm';
  }

  get model(): string {
    return this.#model;
  }

  chat(opts: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: any;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new ToolLLMStream(this, {
      client: this.#client,
      model: this.#model,
      maxToolRounds: this.#maxToolRounds,
      onEvent: this.#onEvent,
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions || { timeoutMs: 30000 },
    });
  }
}

class ToolLLMStream extends llm.LLMStream {
  #client: OpenAI;
  #model: string;
  #maxToolRounds: number;
  #onEvent: EventSender;

  constructor(
    llmInstance: ToolLLM,
    opts: {
      client: OpenAI;
      model: string;
      maxToolRounds: number;
      onEvent: EventSender;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: any;
    },
  ) {
    super(llmInstance, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions,
    });
    this.#client = opts.client;
    this.#model = opts.model;
    this.#maxToolRounds = opts.maxToolRounds;
    this.#onEvent = opts.onEvent;
  }

  protected async run(): Promise<void> {
    const messages = (await this.chatCtx.toProviderFormat(
      'openai',
    )) as OpenAI.ChatCompletionMessageParam[];

    // Tool calling loop
    let round = 0;
    while (round < this.#maxToolRounds) {
      if (this.abortController.signal.aborted) return;

      const isFirstRound = round === 0;
      round++;

      // Call OpenAI with streaming
      const stream = await this.#client.chat.completions.create(
        {
          model: this.#model,
          messages,
          tools: toolDefinitions,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: this.abortController.signal },
      );

      // Accumulate tool calls from the stream
      const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let hasToolCalls = false;

      for await (const chunk of stream) {
        if (this.abortController.signal.aborted) return;

        for (const choice of chunk.choices) {
          const delta = choice.delta;

          // Accumulate tool call deltas
          if (delta?.tool_calls) {
            hasToolCalls = true;
            for (const tc of delta.tool_calls) {
              const existing = toolCalls.get(tc.index);
              if (existing) {
                existing.args += tc.function?.arguments || '';
              } else {
                toolCalls.set(tc.index, {
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  args: tc.function?.arguments || '',
                });
              }
            }
          }

          // Stream text content directly to the pipeline
          if (delta?.content) {
            this.queue.put({
              id: chunk.id,
              delta: { role: 'assistant', content: delta.content },
            });
          }
        }

        // Emit usage
        if (chunk.usage) {
          this.queue.put({
            id: chunk.id,
            usage: {
              completionTokens: chunk.usage.completion_tokens,
              promptTokens: chunk.usage.prompt_tokens,
              promptCachedTokens: 0,
              totalTokens: chunk.usage.total_tokens,
            },
          });
        }
      }

      // If no tool calls, we're done — text was already streamed
      if (!hasToolCalls) return;

      // Execute tools and add results to messages
      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        tool_calls: [...toolCalls.values()].map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      };
      messages.push(assistantMsg);

      for (const tc of toolCalls.values()) {
        console.log(`[ToolLLM] Executing tool: ${tc.name}(${tc.args})`);
        this.#onEvent({ type: 'tool_call', name: tc.name, args: tc.args });
        let result: string;
        try {
          const args = JSON.parse(tc.args);
          result = await executeTool(tc.name, args);
        } catch (e) {
          result = JSON.stringify({ error: `Tool execution failed: ${e}` });
        }
        console.log(`[ToolLLM] Tool result: ${result}`);
        this.#onEvent({ type: 'tool_result', name: tc.name, result });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Loop again — next iteration will stream the final response
    }
  }
}
