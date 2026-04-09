// src/plugins/llm-handler.ts
import type { NavigationCallback } from '../mcp/navigation-server.js';

export type EventSender = (event: Record<string, unknown>) => void;
export type { NavigationCallback };

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
  /** Project context string for non-Agent-SDK backends (e.g. "You are in project X") */
  projectContext?: string;
  /** Local message history for backends without server-side persistence */
  messageHistory?: Array<{ role: string; text: string }>;
  /** Navigation handler for non-Agent-SDK backends */
  navigationHandler?: NavigationCallback;
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
