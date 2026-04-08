# Projects Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project workspaces with voice-first navigation — projects as directories, navigation via in-process MCP server tools, context switching between projects/chats while voice stays connected.

**Architecture:** ProjectStore manages project CRUD and workspace directories. Navigation MCP server provides tools for Claude to list/switch/create projects and chats. ProjectContext in agent tracks current project/session with a navigation stack. Context switching closes current Claude handler and creates a new one with the target project's cwd, MCP servers, and CLAUDE.md.

**Tech Stack:** TypeScript (ESM), Claude Agent SDK (createSdkMcpServer, query API), Express v5, zod

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/project-store.ts` | Create | Project CRUD — create/list/get projects, workspace directory management |
| `src/project-context.ts` | Create | ProjectContext — tracks current project/session, nav stack, loads project config, creates Claude handlers |
| `src/mcp/navigation-server.ts` | Rewrite | Full navigation MCP server with all tools (list/create/switch project, list/switch/new chat, go_back, go_home) |
| `src/plugins/agent-sdk-handler.ts` | Modify | Add `cwd` and `systemPrompt` options to constructor |
| `src/agent.ts` | Modify | Use ProjectContext instead of direct SessionStore, handle context switching |
| `src/token-server.ts` | Modify | Project-scoped API endpoints, project-aware /api/chat, voice lock checking |
| `src/workspace-init.ts` | Create | Initialize workspace on first start, migrate existing sessions |
| `docker-compose.yml` | Modify | Replace session-data volume with workspace volume |
| `docker-compose.prod.yml` | Modify | Same volume change |
| `Dockerfile` | Modify | Create /app/workspace directory |

---

### Task 1: ProjectStore

**Files:**
- Create: `src/project-store.ts`

- [ ] **Step 1: Create ProjectStore with types and CRUD**

```typescript
// src/project-store.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ProjectMeta {
  name: string;
  description: string | null;
  created: string;
}

export class ProjectStore {
  #workspaceDir: string;
  #indexPath: string;

  constructor(workspaceDir: string) {
    this.#workspaceDir = workspaceDir;
    this.#indexPath = path.join(workspaceDir, 'projects.json');
  }

  get workspaceDir(): string {
    return this.#workspaceDir;
  }

  async init(): Promise<void> {
    if (!existsSync(this.#workspaceDir)) {
      await mkdir(this.#workspaceDir, { recursive: true });
    }
    if (!existsSync(this.#indexPath)) {
      await writeFile(this.#indexPath, '[]', 'utf-8');
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    try {
      const data = await readFile(this.#indexPath, 'utf-8');
      return JSON.parse(data) as ProjectMeta[];
    } catch {
      return [];
    }
  }

  async getProject(name: string): Promise<ProjectMeta | null> {
    const projects = await this.listProjects();
    return projects.find(p => p.name === name) || null;
  }

  async createProject(name: string, description?: string): Promise<ProjectMeta> {
    const slug = this.#slugify(name);
    if (slug === '_global') throw new Error('_global is reserved');

    const existing = await this.getProject(slug);
    if (existing) throw new Error(`Project "${slug}" already exists`);

    const projectDir = path.join(this.#workspaceDir, slug);
    await mkdir(path.join(projectDir, 'sessions'), { recursive: true });

    // Create default files
    if (!existsSync(path.join(projectDir, '.mcp.json'))) {
      await writeFile(path.join(projectDir, '.mcp.json'), '{}', 'utf-8');
    }

    const meta: ProjectMeta = {
      name: slug,
      description: description || null,
      created: new Date().toISOString(),
    };

    const projects = await this.listProjects();
    projects.push(meta);
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');

    return meta;
  }

  async updateProject(name: string, updates: { description?: string }): Promise<void> {
    const projects = await this.listProjects();
    const project = projects.find(p => p.name === name);
    if (!project) throw new Error(`Project "${name}" not found`);
    if (updates.description !== undefined) project.description = updates.description;
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');
  }

  getProjectDir(projectName: string): string {
    return path.join(this.#workspaceDir, projectName);
  }

  getSessionsDir(projectName: string): string {
    return path.join(this.#workspaceDir, projectName, 'sessions');
  }

  #slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/jdk/work/incubator/realtimeApi && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/project-store.ts
git commit -m "feat: add ProjectStore for project CRUD and workspace management"
```

---

### Task 2: Workspace Initialization + Migration

**Files:**
- Create: `src/workspace-init.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Create workspace initialization module**

```typescript
// src/workspace-init.ts
import { mkdir, cp, readdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function initWorkspace(workspaceDir: string): Promise<void> {
  const globalDir = path.join(workspaceDir, '_global');
  const globalSessionsDir = path.join(globalDir, 'sessions');

  // Create _global directory structure
  if (!existsSync(globalSessionsDir)) {
    await mkdir(globalSessionsDir, { recursive: true });
  }

  // Default .mcp.json
  const mcpPath = path.join(globalDir, '.mcp.json');
  if (!existsSync(mcpPath)) {
    await writeFile(mcpPath, '{}', 'utf-8');
  }

  // Default CLAUDE.md
  const claudeMdPath = path.join(globalDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    await writeFile(claudeMdPath, '# Global Assistant Instructions\n\nRespond in the language the user speaks.\n', 'utf-8');
  }

  // Default sessions index
  const indexPath = path.join(globalSessionsDir, 'index.json');
  if (!existsSync(indexPath)) {
    await writeFile(indexPath, '[]', 'utf-8');
  }

  // projects.json
  const projectsPath = path.join(workspaceDir, 'projects.json');
  if (!existsSync(projectsPath)) {
    await writeFile(projectsPath, '[]', 'utf-8');
  }

  console.log(`[Workspace] Initialized at ${workspaceDir}`);
}

/**
 * Migrate sessions from old data/sessions/ to workspace/_global/sessions/
 */
export async function migrateOldSessions(
  oldSessionsDir: string,
  workspaceDir: string,
): Promise<void> {
  const targetDir = path.join(workspaceDir, '_global', 'sessions');

  if (!existsSync(oldSessionsDir)) return;

  // Check if already migrated (target has index.json with entries)
  const targetIndex = path.join(targetDir, 'index.json');
  if (existsSync(targetIndex)) {
    try {
      const data = await readFile(targetIndex, 'utf-8');
      const index = JSON.parse(data);
      if (index.length > 0) {
        console.log('[Workspace] Sessions already migrated, skipping');
        return;
      }
    } catch {}
  }

  // Copy all files from old to new
  try {
    const files = await readdir(oldSessionsDir);
    for (const file of files) {
      const src = path.join(oldSessionsDir, file);
      const dst = path.join(targetDir, file);
      if (!existsSync(dst)) {
        await cp(src, dst);
      }
    }
    console.log(`[Workspace] Migrated ${files.length} files from ${oldSessionsDir} to ${targetDir}`);
  } catch (err) {
    console.error('[Workspace] Migration failed:', err);
  }
}
```

- [ ] **Step 2: Update Dockerfile**

Change the mkdir line to include workspace:

```dockerfile
RUN mkdir -p /home/node/.claude /app/workspace/_global/sessions && chown -R node:node /app /home/node
```

- [ ] **Step 3: Update docker-compose.yml**

Replace `session-data` volume with `workspace`:

In agent volumes, change:
```yaml
      - session-data:/app/data/sessions
```
to:
```yaml
      - workspace:/app/workspace
```

In top-level volumes, change `session-data:` to `workspace:`.

- [ ] **Step 4: Update docker-compose.prod.yml**

Same changes: `session-data:/app/data/sessions` → `workspace:/app/workspace`, rename volume.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/workspace-init.ts Dockerfile docker-compose.yml docker-compose.prod.yml
git commit -m "feat: workspace initialization and session migration"
```

---

### Task 3: ProjectContext

**Files:**
- Create: `src/project-context.ts`

- [ ] **Step 1: Create ProjectContext class**

```typescript
// src/project-context.ts
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SessionStore, type SessionData } from './session-store.js';
import { ProjectStore } from './project-store.js';

export interface NavStackEntry {
  projectName: string;
  sessionId: string;
}

export interface ProjectConfig {
  cwd: string;
  systemPrompt: string;
  mcpConfig: Record<string, unknown>;
}

export class ProjectContext {
  #projectStore: ProjectStore;
  #currentProject: string; // '_global' or project name
  #currentSessionStore: SessionStore;
  #currentSession: SessionData | null;
  #navStack: NavStackEntry[];

  constructor(projectStore: ProjectStore, initialProject: string = '_global') {
    this.#projectStore = projectStore;
    this.#currentProject = initialProject;
    this.#currentSessionStore = new SessionStore(
      projectStore.getSessionsDir(initialProject),
    );
    this.#currentSession = null;
    this.#navStack = [];
  }

  get currentProject(): string {
    return this.#currentProject;
  }

  get currentSession(): SessionData | null {
    return this.#currentSession;
  }

  get sessionStore(): SessionStore {
    return this.#currentSessionStore;
  }

  set currentSession(session: SessionData | null) {
    this.#currentSession = session;
  }

  async init(): Promise<void> {
    await this.#currentSessionStore.init();
  }

  /**
   * Switch to a different project + chat. Pushes current position to nav stack.
   */
  async switchTo(projectName: string, sessionId?: string): Promise<SessionData | null> {
    // Push current position to nav stack (if we have a session)
    if (this.#currentSession) {
      this.#navStack.push({
        projectName: this.#currentProject,
        sessionId: this.#currentSession.sessionId,
      });
    }

    // Switch project
    this.#currentProject = projectName;
    this.#currentSessionStore = new SessionStore(
      this.#projectStore.getSessionsDir(projectName),
    );
    await this.#currentSessionStore.init();

    // Load or create session
    if (sessionId) {
      this.#currentSession = await this.#currentSessionStore.getSession(sessionId);
    } else {
      this.#currentSession = null; // lazy creation later
    }

    return this.#currentSession;
  }

  /**
   * Go back to previous position in nav stack.
   */
  async goBack(): Promise<NavStackEntry | null> {
    const entry = this.#navStack.pop();
    if (!entry) return null;

    this.#currentProject = entry.projectName;
    this.#currentSessionStore = new SessionStore(
      this.#projectStore.getSessionsDir(entry.projectName),
    );
    await this.#currentSessionStore.init();
    this.#currentSession = await this.#currentSessionStore.getSession(entry.sessionId);

    return entry;
  }

  /**
   * Load project configuration for creating a Claude handler.
   */
  async loadProjectConfig(): Promise<ProjectConfig> {
    const workspaceDir = this.#projectStore.workspaceDir;
    const projectDir = this.#projectStore.getProjectDir(this.#currentProject);

    // Read CLAUDE.md files (global + project, layered)
    const globalClaudeMd = await this.#readFileOrEmpty(
      path.join(workspaceDir, '_global', 'CLAUDE.md'),
    );
    const projectClaudeMd = this.#currentProject !== '_global'
      ? await this.#readFileOrEmpty(path.join(projectDir, 'CLAUDE.md'))
      : '';
    const systemPrompt = [globalClaudeMd, projectClaudeMd].filter(Boolean).join('\n\n');

    // Read .mcp.json files (global + project)
    const globalMcp = await this.#readJsonOrEmpty(
      path.join(workspaceDir, '_global', '.mcp.json'),
    );
    const projectMcp = this.#currentProject !== '_global'
      ? await this.#readJsonOrEmpty(path.join(projectDir, '.mcp.json'))
      : {};
    const mcpConfig = { ...globalMcp, ...projectMcp };

    return {
      cwd: projectDir,
      systemPrompt,
      mcpConfig,
    };
  }

  async #readFileOrEmpty(filePath: string): Promise<string> {
    if (!existsSync(filePath)) return '';
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  async #readJsonOrEmpty(filePath: string): Promise<Record<string, unknown>> {
    if (!existsSync(filePath)) return {};
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/project-context.ts
git commit -m "feat: add ProjectContext for project/session navigation with stack"
```

---

### Task 4: Navigation MCP Server (Full)

**Files:**
- Rewrite: `src/mcp/navigation-server.ts`

- [ ] **Step 1: Rewrite navigation server with all tools**

Replace the PoC with the full implementation. The callback now returns structured data, and the server defines all 8 tools from the spec.

```typescript
// src/mcp/navigation-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export type NavigationCommand =
  | { type: 'list_projects' }
  | { type: 'create_project'; name: string; description?: string }
  | { type: 'switch_project'; projectName: string }
  | { type: 'list_chats'; count?: number; hoursAgo?: number }
  | { type: 'switch_chat'; projectName: string; chatId: string }
  | { type: 'new_chat'; projectName: string }
  | { type: 'go_back' }
  | { type: 'go_home' };

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
        'List chats in the current project. Filterable by count or time.',
        {
          count: z.number().optional().describe('Max number of chats to return'),
          hoursAgo: z.number().optional().describe('Only chats from the last N hours'),
        },
        async (args) => {
          const result = await onCommand({ type: 'list_chats', count: args.count, hoursAgo: args.hoursAgo });
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
    ],
  });
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/mcp/navigation-server.ts
git commit -m "feat: full navigation MCP server with all project/chat tools"
```

---

### Task 5: AgentSDKHandler — cwd + systemPrompt options

**Files:**
- Modify: `src/plugins/agent-sdk-handler.ts`

- [ ] **Step 1: Add cwd and systemPrompt options**

In the `AgentSDKHandlerOptions` interface, add:
```typescript
  cwd?: string;
  systemPrompt?: string;
```

Add private fields:
```typescript
  #cwd: string | undefined;
  #systemPrompt: string | undefined;
```

In constructor:
```typescript
    this.#cwd = opts.cwd;
    this.#systemPrompt = opts.systemPrompt;
```

In the `query()` call, change:
```typescript
        systemPrompt: SYSTEM_INSTRUCTIONS,
```
to:
```typescript
        systemPrompt: this.#systemPrompt || SYSTEM_INSTRUCTIONS,
```

And add `cwd` to options if set:
```typescript
        ...(this.#cwd ? { cwd: this.#cwd } : {}),
```

This goes in the `options` object passed to `query()`, after `extraArgs`.

- [ ] **Step 2: Export SYSTEM_INSTRUCTIONS so callers can prepend to it**

Add `export` to the const:
```typescript
export const SYSTEM_INSTRUCTIONS = `...`;
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/plugins/agent-sdk-handler.ts
git commit -m "feat: add cwd and systemPrompt options to AgentSDKHandler"
```

---

### Task 6: Navigation Command Handler

**Files:**
- Create: `src/navigation-handler.ts`

This module implements the logic for each navigation command — called by both agent (voice) and token-server (text).

- [ ] **Step 1: Create navigation handler**

```typescript
// src/navigation-handler.ts
import { ProjectStore } from './project-store.js';
import { ProjectContext } from './project-context.js';
import type { NavigationCommand } from './mcp/navigation-server.js';

export type ContextSwitchCallback = (projectName: string, sessionId: string | null) => Promise<void>;

export function createNavigationHandler(
  projectStore: ProjectStore,
  projectContext: ProjectContext,
  onContextSwitch: ContextSwitchCallback,
) {
  return async (cmd: NavigationCommand): Promise<string> => {
    switch (cmd.type) {
      case 'list_projects': {
        const projects = await projectStore.listProjects();
        if (projects.length === 0) {
          return 'No projects yet. You can create one by saying "create project <name>".';
        }
        const list = projects
          .map((p, i) => `${i + 1}. ${p.name}${p.description ? ` — ${p.description}` : ''}`)
          .join('\n');
        return `Available projects:\n${list}`;
      }

      case 'create_project': {
        try {
          const project = await projectStore.createProject(cmd.name, cmd.description);
          return `Project "${project.name}" created.${project.description ? ` Description: ${project.description}` : ''}`;
        } catch (err: any) {
          return `Failed to create project: ${err.message}`;
        }
      }

      case 'switch_project': {
        const project = await projectStore.getProject(cmd.projectName);
        if (!project) {
          return `Project "${cmd.projectName}" not found. Use list_projects to see available projects.`;
        }
        // Load recent chats from target project
        const { SessionStore } = await import('./session-store.js');
        const targetSessions = new SessionStore(projectStore.getSessionsDir(cmd.projectName));
        await targetSessions.init();
        const chats = await targetSessions.listSessions();
        const recent = chats.slice(0, 5);

        let response = `Project: ${project.name}`;
        if (project.description) response += `\nDescription: ${project.description}`;

        if (recent.length > 0) {
          response += `\n\nRecent chats:`;
          for (const chat of recent) {
            const age = getTimeAgo(chat.updated);
            response += `\n- "${chat.name || chat.preview}" (${age}, ${chat.messageCount} messages, ID: ${chat.sessionId})`;
          }
          response += '\n\nWant to continue one of these or start a new chat?';
        } else {
          response += '\n\nNo chats yet. Want to start a new chat?';
        }

        return response;
      }

      case 'list_chats': {
        let chats = await projectContext.sessionStore.listSessions();
        if (cmd.hoursAgo) {
          const cutoff = Date.now() - cmd.hoursAgo * 60 * 60 * 1000;
          chats = chats.filter(c => new Date(c.updated).getTime() > cutoff);
        }
        if (cmd.count) {
          chats = chats.slice(0, cmd.count);
        }
        if (chats.length === 0) {
          return 'No chats found matching your criteria.';
        }
        const list = chats
          .map(c => {
            const age = getTimeAgo(c.updated);
            return `- "${c.name || c.preview}" (${age}, ${c.messageCount} messages, ID: ${c.sessionId})`;
          })
          .join('\n');
        return `Chats in ${projectContext.currentProject}:\n${list}`;
      }

      case 'switch_chat': {
        await onContextSwitch(cmd.projectName, cmd.chatId);
        return `Switched to chat in project "${cmd.projectName}".`;
      }

      case 'new_chat': {
        await onContextSwitch(cmd.projectName, null);
        return `New chat started in project "${cmd.projectName}".`;
      }

      case 'go_back': {
        const prev = projectContext.currentSession;
        // goBack is called by onContextSwitch indirectly — we need the stack entry
        const entry = await projectContext.goBack();
        if (!entry) {
          return 'No previous context to return to.';
        }
        return `Returned to project "${entry.projectName}".`;
      }

      case 'go_home': {
        await onContextSwitch('_global', null);
        return 'Returned to home space.';
      }

      default:
        return 'Unknown navigation command.';
    }
  };
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/navigation-handler.ts
git commit -m "feat: navigation command handler for project/chat switching"
```

---

### Task 7: Agent — ProjectContext Integration

**Files:**
- Modify: `src/agent.ts`

This is the core integration: agent uses ProjectContext for voice sessions, navigation MCP server triggers context switches.

- [ ] **Step 1: Replace SessionStore with ProjectContext**

Replace imports:
```typescript
import { SessionStore, type SessionMessage, type SessionData } from './session-store.js';
```
with:
```typescript
import { type SessionMessage, type SessionData } from './session-store.js';
import { ProjectStore } from './project-store.js';
import { ProjectContext } from './project-context.js';
import { initWorkspace, migrateOldSessions } from './workspace-init.js';
import { createNavigationMcpServer, NAVIGATION_TOOL_NAMES } from './mcp/navigation-server.js';
import { createNavigationHandler } from './navigation-handler.js';
import { SYSTEM_INSTRUCTIONS } from './plugins/agent-sdk-handler.js';
```

- [ ] **Step 2: Initialize workspace and ProjectContext in entry**

Replace the session store initialization block:
```typescript
    // Session store
    const sessionStore = new SessionStore(
      path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data', 'sessions'),
    );
    await sessionStore.init();
```

With:
```typescript
    // Workspace + project context
    const workspaceDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'workspace');
    await initWorkspace(workspaceDir);

    // Migrate old sessions if they exist
    const oldSessionsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data', 'sessions');
    await migrateOldSessions(oldSessionsDir, workspaceDir);

    const projectStore = new ProjectStore(workspaceDir);
    await projectStore.init();

    const projectCtx = new ProjectContext(projectStore, '_global');
    await projectCtx.init();
```

- [ ] **Step 3: Add context switch function and navigation MCP server**

After ProjectContext init, add:

```typescript
    // Voice lock — published so token-server can check
    let voiceLockFile = path.join(workspaceDir, '.voice-lock.json');

    async function updateVoiceLock() {
      const lock = projectCtx.currentSession
        ? { projectName: projectCtx.currentProject, sessionId: projectCtx.currentSession.sessionId }
        : null;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(voiceLockFile, JSON.stringify(lock), 'utf-8');
    }

    async function performContextSwitch(projectName: string, sessionId: string | null) {
      // Close current Claude handler
      claude.close();

      // Switch project context
      if (projectName === projectCtx.currentProject && sessionId) {
        // Same project, different chat
        projectCtx.currentSession = await projectCtx.sessionStore.getSession(sessionId);
      } else {
        await projectCtx.switchTo(projectName, sessionId || undefined);
      }

      // Load project config
      const config = await projectCtx.loadProjectConfig();

      // Compose system prompt with navigation instructions
      const navPrompt = `When switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation.`;
      const fullPrompt = [SYSTEM_INSTRUCTIONS, config.systemPrompt, navPrompt].filter(Boolean).join('\n\n');

      // Create navigation MCP server
      const navServer = createNavigationMcpServer(navHandler);

      // Create new Claude handler
      claude = new AgentSDKHandler({
        model: 'claude-sonnet-4-6',
        cwd: config.cwd,
        systemPrompt: fullPrompt,
        mcpServers: { navigation: navServer, ...config.mcpConfig },
        additionalAllowedTools: NAVIGATION_TOOL_NAMES,
        onEvent: sendEvent,
        onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
        onAssistantMessage: (text) => handleAssistantMessage(text),
        onToolCall: (name, input) => handleToolCall(name, input),
      });

      // Update voice lock
      await updateVoiceLock();

      // Notify frontend
      sendEvent({
        type: 'context_switched',
        projectName: projectCtx.currentProject,
        sessionId: projectCtx.currentSession?.sessionId || null,
      });

      console.log(`[Agent] Context switched to ${projectName}/${sessionId || 'new'}`);
    }

    const navHandler = createNavigationHandler(projectStore, projectCtx, performContextSwitch);
```

- [ ] **Step 4: Update Claude handler creation to include navigation**

Replace the initial Claude handler creation with:

```typescript
    // Create navigation MCP server for initial context
    const initialConfig = await projectCtx.loadProjectConfig();
    const navPrompt = `When switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation.`;
    const initialPrompt = [SYSTEM_INSTRUCTIONS, initialConfig.systemPrompt, navPrompt].filter(Boolean).join('\n\n');
    const navServer = createNavigationMcpServer(navHandler);

    let claude = new AgentSDKHandler({
      model: 'claude-sonnet-4-6',
      cwd: initialConfig.cwd,
      systemPrompt: initialPrompt,
      mcpServers: { navigation: navServer, ...initialConfig.mcpConfig },
      additionalAllowedTools: NAVIGATION_TOOL_NAMES,
      onEvent: sendEvent,
      onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
      onAssistantMessage: (text) => handleAssistantMessage(text),
      onToolCall: (name, input) => handleToolCall(name, input),
    });
```

- [ ] **Step 5: Update session_init handler to support projectName**

Change the session_init handler to also accept `projectName`:

```typescript
        if (msg.type === 'session_init') {
          const projectName = (msg.projectName as string) || '_global';
          const sessionId = msg.sessionId as string | undefined;

          console.log(`[Agent] session_init: project=${projectName}, session=${sessionId}`);

          // Switch to the requested project
          await projectCtx.switchTo(projectName, sessionId);
          await projectCtx.init();

          // Load config and recreate Claude handler
          await performContextSwitch(projectName, sessionId || null);
        }
```

- [ ] **Step 6: Update ensureSession and helpers to use projectCtx**

Replace `sessionStore` references with `projectCtx.sessionStore`:

```typescript
    async function ensureSession(): Promise<SessionData> {
      if (!projectCtx.currentSession) {
        projectCtx.currentSession = await projectCtx.sessionStore.createSession();
        console.log(`[Agent] New session created: ${projectCtx.currentSession.sessionId}`);
        sendEvent({ type: 'session_info', sessionId: projectCtx.currentSession.sessionId });
      }
      return projectCtx.currentSession;
    }

    async function handleSessionIdCaptured(claudeSessionId: string) {
      const session = await ensureSession();
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await projectCtx.sessionStore.setClaudeSessionId(session.sessionId, claudeSessionId);
        console.log(`[Agent] Session ${session.sessionId} linked to Claude: ${claudeSessionId}`);
      }
    }

    async function handleAssistantMessage(text: string) {
      const session = await ensureSession();
      const msg: SessionMessage = { role: 'assistant', text, timestamp: new Date().toISOString() };
      await projectCtx.sessionStore.addMessage(session.sessionId, msg);
    }

    async function handleToolCall(name: string, input: string) {
      const session = await ensureSession();
      const msg: SessionMessage = { role: 'tool', text: `${name}: ${input}`, timestamp: new Date().toISOString(), name, input };
      await projectCtx.sessionStore.addMessage(session.sessionId, msg);
    }
```

Also update `processUserText` to use `projectCtx.sessionStore`:
```typescript
      ensureSession().then(session => {
        const userMsg: SessionMessage = { role: 'user', text: userText, timestamp: new Date().toISOString() };
        return projectCtx.sessionStore.addMessage(session.sessionId, userMsg);
      }).catch(...)
```

- [ ] **Step 7: Update the final session_info send**

```typescript
    sendEvent({
      type: 'session_info',
      sessionId: projectCtx.currentSession?.sessionId ?? null,
      projectName: projectCtx.currentProject,
    });
```

- [ ] **Step 8: Clean up voice lock on close**

In the Close handler, add cleanup:
```typescript
    agentSession.on(voice.AgentSessionEventTypes.Close, async (ev) => {
      console.log('Session closed:', ev.reason, ev.error);
      sendEvent({ type: 'error', reason: ev.reason, error: ev.error ? String(ev.error) : null });
      claude.interrupt();
      // Clear voice lock
      const { writeFile } = await import('node:fs/promises');
      await writeFile(voiceLockFile, 'null', 'utf-8').catch(() => {});
    });
```

- [ ] **Step 9: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 10: Commit**

```bash
git add src/agent.ts
git commit -m "feat: integrate ProjectContext and navigation into agent"
```

---

### Task 8: Token Server — Project-Scoped API

**Files:**
- Modify: `src/token-server.ts`

- [ ] **Step 1: Replace central SessionStore with workspace-based setup**

Replace the module-level SessionStore initialization:
```typescript
const sessionStore = new SessionStore(
  path.resolve(__dirname, '..', 'data', 'sessions'),
);
await sessionStore.init();
```

With:
```typescript
import { ProjectStore } from './project-store.js';
import { initWorkspace } from './workspace-init.js';
import { NAVIGATION_TOOL_NAMES } from './mcp/navigation-server.js';

const workspaceDir = path.resolve(__dirname, '..', 'workspace');
await initWorkspace(workspaceDir);

const projectStore = new ProjectStore(workspaceDir);
await projectStore.init();

// Helper to get session store for a project
function getSessionStore(projectName: string): SessionStore {
  return new SessionStore(projectStore.getSessionsDir(projectName || '_global'));
}
```

- [ ] **Step 2: Add project API endpoints**

After the health endpoint, add:

```typescript
// --- Project API ---

app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await projectStore.listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const project = await projectStore.createProject(name, description);
    res.json(project);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/projects/:name', async (req, res) => {
  try {
    const project = await projectStore.getProject(req.params.name);
    if (!project) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get project' });
  }
});

app.patch('/api/projects/:name', async (req, res) => {
  try {
    await projectStore.updateProject(req.params.name, req.body);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Replace old session endpoints with project-scoped ones**

Replace the old `/api/sessions` endpoints with:

```typescript
// --- Session API (project-scoped) ---

app.get('/api/projects/:name/sessions', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    const q = req.query.q as string | undefined;
    const sessions = await store.listSessions(q);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

app.get('/api/projects/:name/sessions/:id', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    const session = await store.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.patch('/api/projects/:name/sessions/:id', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    await store.setName(req.params.id, req.body.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update session' });
  }
});

app.post('/api/projects/:name/sessions/:id/generate-name', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    const session = await store.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    const transcript = session.messages
      .filter(m => m.role !== 'tool')
      .slice(0, 10)
      .map(m => `${m.role}: ${m.text}`)
      .join('\n');

    const claude = new AgentSDKHandler({ model: 'claude-haiku-4-5' });
    let generatedName = '';
    await claude.sendAndStream(
      `Generate a short title (3-6 words, no quotes) for this conversation:\n\n${transcript}`,
      (sentence) => { generatedName += sentence + ' '; },
    );
    claude.close();

    const name = generatedName.trim().slice(0, 60);
    await store.setName(session.sessionId, name);
    res.json({ name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate name' });
  }
});

// Backward compat: /api/sessions → /api/projects/_global/sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const store = getSessionStore('_global');
    await store.init();
    const sessions = await store.listSessions(req.query.q as string | undefined);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});
```

- [ ] **Step 4: Update /api/chat to be project-aware**

Update the `/api/chat` handler to accept `projectName`:

Change:
```typescript
  const { text, sessionId } = req.body;
```
to:
```typescript
  const { text, sessionId, projectName = '_global' } = req.body;
```

Replace the session store usage to be project-scoped:
```typescript
  const store = getSessionStore(projectName);
  await store.init();

  // Check voice lock
  const lockPath = path.join(workspaceDir, '.voice-lock.json');
  try {
    const { readFile } = await import('node:fs/promises');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    if (lock && lock.sessionId === sessionId && lock.projectName === projectName) {
      res.status(409).json({ error: 'This chat is currently active in voice mode' });
      return;
    }
  } catch {}

  let session;
  if (sessionId) {
    session = await store.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  } else {
    session = await store.createSession();
  }
```

Update all `sessionStore` references in the handler to `store`.

Add navigation MCP server to the chat handler (reuse existing PoC pattern but with project-aware callback):

```typescript
  const navServer = createNavigationMcpServer(async (cmd) => {
    // For text chat, navigation returns info but context_switched event tells frontend
    // Token-server text is stateless — actual switch happens via frontend sending new projectName/sessionId
    console.log(`[Nav/Text] Command: ${JSON.stringify(cmd)}`);
    // Import and use same handler logic
    const { ProjectContext } = await import('./project-context.js');
    const { createNavigationHandler } = await import('./navigation-handler.js');
    const tempCtx = new ProjectContext(projectStore, projectName);
    await tempCtx.init();
    const handler = createNavigationHandler(projectStore, tempCtx, async (proj, sid) => {
      // Signal context switch to frontend
      res.write(`data: ${JSON.stringify({ type: 'context_switched', projectName: proj, sessionId: sid })}\n\n`);
    });
    return handler(cmd);
  });
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/token-server.ts
git commit -m "feat: project-scoped API endpoints and project-aware chat"
```

---

### Task 9: Frontend — Minimal Context Switch Handling

**Files:**
- Modify: `web/app.js`

Minimal changes to handle `context_switched` events. Full UI (project sidebar, project switcher) is Spec 2.

- [ ] **Step 1: Add project state tracking**

In `sessionState`, add:
```javascript
  currentProject: '_global',
```

- [ ] **Step 2: Handle context_switched from voice (DataReceived)**

In the `RoomEvent.DataReceived` handler, add a case:

```javascript
    else if (msg.type === 'context_switched') {
      sessionState.currentProject = msg.projectName;
      sessionState.currentSessionId = msg.sessionId;
      // Reload conversation for new context
      if (msg.sessionId) {
        try {
          const res = await fetch(`/api/projects/${msg.projectName}/sessions/${msg.sessionId}`);
          if (res.ok) {
            const session = await res.json();
            $('#conversation').innerHTML = '';
            for (const m of session.messages) {
              if (m.role === 'tool') continue;
              addMessage(m.role === 'user' ? 'user' : 'assistant', m.text);
            }
          }
        } catch {}
      } else {
        $('#conversation').innerHTML = '';
      }
      fetchSessions();
      updateSessionBar();
      logEvent('agent', `Context switched: ${msg.projectName}/${msg.sessionId || 'new'}`);
    }
```

- [ ] **Step 3: Handle context_switched from text (SSE)**

In the SSE reader loop (inside `sendTextMessage`), add:
```javascript
        } else if (data.type === 'context_switched') {
          sessionState.currentProject = data.projectName;
          sessionState.currentSessionId = data.sessionId;
          // Reload will happen on next fetch
          fetchSessions();
          updateSessionBar();
```

- [ ] **Step 4: Update fetchSessions to be project-aware**

Change the fetch URL in `fetchSessions`:
```javascript
  const project = sessionState.currentProject || '_global';
  const url = query
    ? `/api/projects/${project}/sessions?q=${encodeURIComponent(query)}`
    : `/api/projects/${project}/sessions`;
```

- [ ] **Step 5: Update session detail fetches to be project-aware**

In `onSessionClick`, update the fetch:
```javascript
    const res = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${sessionId}`);
```

In `resumeSession`, update the fetch:
```javascript
    const sessionRes = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${sessionId}`);
```

In the `sendTextMessage` body, add `projectName`:
```javascript
      body: JSON.stringify({
        text,
        sessionId: targetSessionId || undefined,
        projectName: sessionState.currentProject || '_global',
      }),
```

- [ ] **Step 6: Update session_init to include projectName**

In the Connect handler (where `pendingResumeSessionId` is set), also set `pendingResumeProject`:

```javascript
    if (sessionState.currentSessionId) {
      sessionState.pendingResumeSessionId = sessionState.currentSessionId;
      sessionState.pendingResumeProject = sessionState.currentProject;
    }
```

In the session_info handler where session_init is sent:
```javascript
        room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({
            type: 'session_init',
            sessionId: resumeId,
            projectName: sessionState.pendingResumeProject || '_global',
          })),
          { reliable: true }
        );
```

- [ ] **Step 7: Update session name bar and generate-name to be project-aware**

Update the blur handler:
```javascript
  await fetch(`/api/projects/${sessionState.currentProject}/sessions/${targetId}`, { ... });
```

Update the generate button:
```javascript
    const res = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${targetId}/generate-name`, { method: 'POST' });
```

- [ ] **Step 8: Commit**

```bash
git add web/app.js
git commit -m "feat: frontend handles context_switched events, project-aware API calls"
```

---

### Task 10: Docker + Docs + Verification

**Files:**
- Modify: `CLAUDE.md`
- Verify: compilation and startup

- [ ] **Step 1: Update CLAUDE.md**

Add/update sections for projects:
- Architecture: mention ProjectStore, ProjectContext, navigation MCP server
- Add Projects section explaining workspace structure
- Update Docker section about workspace volume
- Update Commands section

- [ ] **Step 2: Full compilation check**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Docker rebuild (Dockerfile changed)**

```bash
docker compose build agent
```

- [ ] **Step 4: Start and verify**

```bash
docker compose up -d
```

Wait for startup, then test:
```bash
# Check both services running
docker compose logs agent | grep "Token server\|registered worker"

# Test project API
curl -s http://localhost:3001/api/projects

# Test backward compat
curl -s http://localhost:3001/api/sessions

# Test project creation via text
curl -s -X POST http://localhost:3001/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"test-project","description":"Test"}'
```

- [ ] **Step 5: Manual test flow**

1. Open http://localhost:3001
2. Type "Jaké projekty mám?" → should call list_projects, show empty list
3. Type "Vytvoř projekt test-project" → should call create_project
4. Type "Přepni se do projektu test-project" → should call switch_project, show info
5. Type "Nový chat" → should trigger context_switched, frontend updates
6. Click Connect → voice should work in the project context
7. Say "Vrať se domů" → should trigger go_home, back to _global

- [ ] **Step 6: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for projects feature"
```
