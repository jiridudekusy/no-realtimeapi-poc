import type { LlmConfig } from '../pipeline-config.js';
import type { LLMHandler, LLMHandlerOptions } from './llm-handler.js';
import { AgentSDKHandler } from './agent-sdk-handler.js';
import { OpenAIChatHandler } from './openai-chat-handler.js';

export type LLMFactoryOptions = LLMHandlerOptions;

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
