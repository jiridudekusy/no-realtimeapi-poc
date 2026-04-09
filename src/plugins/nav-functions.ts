// src/plugins/nav-functions.ts
// Navigation tools as OpenAI function definitions + executor for non-Claude backends.

import type { NavigationCallback, NavigationCommand } from '../mcp/navigation-server.js';
import type OpenAI from 'openai';

export const navigationTools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List all available projects with descriptions.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Create a new project. Use when user says "create project X" or "new project X".',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Project name',
          },
          description: {
            type: 'string',
            description: 'Optional project description',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_project',
      description: 'Get info about a project and its recent chats. Does NOT switch — use switch_chat or new_chat after user confirms.',
      parameters: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Project name',
          },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_chats',
      description: 'List chats in a project. Defaults to current project if projectName not specified. Filterable by count or time.',
      parameters: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Project name (default: current project)',
          },
          count: {
            type: 'number',
            description: 'Max number of chats to return',
          },
          hoursAgo: {
            type: 'number',
            description: 'Only chats from the last N hours',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_chat',
      description: 'Switch to a specific chat in a project. ONLY call after user confirms they want to switch.',
      parameters: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Target project name',
          },
          chatId: {
            type: 'string',
            description: 'Session ID of the chat to switch to',
          },
        },
        required: ['projectName', 'chatId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_chat',
      description: 'Create a new chat in a project and switch to it. ONLY call after user confirms.',
      parameters: {
        type: 'object',
        properties: {
          projectName: {
            type: 'string',
            description: 'Target project name',
          },
        },
        required: ['projectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: 'Return to the previous project/chat. ONLY call after user confirms.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_home',
      description: 'Return to the home space (no project). ONLY call after user confirms.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_chat',
      description: 'Rename the current chat/conversation. Use when user says "rename this chat", "call this conversation X", etc.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'New name for the current chat',
          },
        },
        required: ['name'],
      },
    },
  },
];

export async function executeNavFunction(
  functionName: string,
  args: Record<string, unknown>,
  onCommand: NavigationCallback,
): Promise<string> {
  let cmd: NavigationCommand;

  switch (functionName) {
    case 'list_projects':
      cmd = { type: 'list_projects' };
      break;
    case 'create_project':
      cmd = {
        type: 'create_project',
        name: args.name as string,
        description: args.description as string | undefined,
      };
      break;
    case 'switch_project':
      cmd = { type: 'switch_project', projectName: args.projectName as string };
      break;
    case 'list_chats':
      cmd = {
        type: 'list_chats',
        projectName: args.projectName as string | undefined,
        count: args.count as number | undefined,
        hoursAgo: args.hoursAgo as number | undefined,
      };
      break;
    case 'switch_chat':
      cmd = {
        type: 'switch_chat',
        projectName: args.projectName as string,
        chatId: args.chatId as string,
      };
      break;
    case 'new_chat':
      cmd = { type: 'new_chat', projectName: args.projectName as string };
      break;
    case 'go_back':
      cmd = { type: 'go_back' };
      break;
    case 'go_home':
      cmd = { type: 'go_home' };
      break;
    case 'rename_chat':
      cmd = { type: 'rename_chat', name: args.name as string };
      break;
    default:
      throw new Error(`Unknown navigation function: ${functionName}`);
  }

  return onCommand(cmd);
}
