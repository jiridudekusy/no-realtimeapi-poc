import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export type NavigationCommand =
  | { type: 'list_projects' }
  | { type: 'create_project'; name: string; description?: string }
  | { type: 'switch_project'; projectName: string }
  | { type: 'list_chats'; projectName?: string; count?: number; hoursAgo?: number }
  | { type: 'switch_chat'; projectName: string; chatId: string }
  | { type: 'new_chat'; projectName: string }
  | { type: 'go_back' }
  | { type: 'go_home' }
  | { type: 'rename_chat'; name: string };

export type NavigationCallback = (cmd: NavigationCommand) => Promise<string>;

export const NAVIGATION_TOOL_NAMES = [
  'mcp__navigation__list_projects',
  'mcp__navigation__create_project',
  'mcp__navigation__switch_project',
  'mcp__navigation__list_chats',
  'mcp__navigation__switch_chat',
  'mcp__navigation__new_chat',
  'mcp__navigation__go_back',
  'mcp__navigation__go_home',
  'mcp__navigation__rename_chat',
];

export function createNavigationMcpServer(onCommand: NavigationCallback) {
  return createSdkMcpServer({
    name: 'navigation',
    version: '1.0.0',
    tools: [
      tool(
        'list_projects',
        'List all available projects with descriptions.',
        {},
        async () => {
          const result = await onCommand({ type: 'list_projects' });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'create_project',
        'Create a new project. Use when user says "create project X" or "new project X".',
        {
          name: z.string().describe('Project name'),
          description: z.string().optional().describe('Optional project description'),
        },
        async (args) => {
          const result = await onCommand({ type: 'create_project', name: args.name, description: args.description });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'switch_project',
        'Get info about a project and its recent chats. Does NOT switch — use switch_chat or new_chat after user confirms.',
        { projectName: z.string().describe('Project name') },
        async (args) => {
          const result = await onCommand({ type: 'switch_project', projectName: args.projectName });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'list_chats',
        'List chats in a project. Defaults to current project if projectName not specified. Filterable by count or time.',
        {
          projectName: z.string().optional().describe('Project name (default: current project)'),
          count: z.number().optional().describe('Max number of chats to return'),
          hoursAgo: z.number().optional().describe('Only chats from the last N hours'),
        },
        async (args) => {
          const result = await onCommand({ type: 'list_chats', projectName: args.projectName, count: args.count, hoursAgo: args.hoursAgo });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'switch_chat',
        'Switch to a specific chat in a project. ONLY call after user confirms they want to switch.',
        {
          projectName: z.string().describe('Target project name'),
          chatId: z.string().describe('Session ID of the chat to switch to'),
        },
        async (args) => {
          const result = await onCommand({ type: 'switch_chat', projectName: args.projectName, chatId: args.chatId });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'new_chat',
        'Create a new chat in a project and switch to it. ONLY call after user confirms.',
        { projectName: z.string().describe('Target project name') },
        async (args) => {
          const result = await onCommand({ type: 'new_chat', projectName: args.projectName });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'go_back',
        'Return to the previous project/chat. ONLY call after user confirms.',
        {},
        async () => {
          const result = await onCommand({ type: 'go_back' });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'go_home',
        'Return to the home space (no project). ONLY call after user confirms.',
        {},
        async () => {
          const result = await onCommand({ type: 'go_home' });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
      tool(
        'rename_chat',
        'Rename the current chat/conversation. Use when user says "rename this chat", "call this conversation X", etc.',
        { name: z.string().describe('New name for the current chat') },
        async (args) => {
          const result = await onCommand({ type: 'rename_chat', name: args.name });
          return { content: [{ type: 'text' as const, text: result }] };
        },
      ),
    ],
  });
}
