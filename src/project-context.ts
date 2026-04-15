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
  #currentProject: string;
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

  async switchTo(projectName: string, sessionId?: string): Promise<SessionData | null> {
    if (this.#currentSession) {
      this.#navStack.push({
        projectName: this.#currentProject,
        sessionId: this.#currentSession.sessionId,
      });
    }

    this.#currentProject = projectName;
    this.#currentSessionStore = new SessionStore(
      this.#projectStore.getSessionsDir(projectName),
    );
    await this.#currentSessionStore.init();

    if (sessionId) {
      this.#currentSession = await this.#currentSessionStore.getSession(sessionId);
    } else {
      this.#currentSession = null;
    }

    return this.#currentSession;
  }

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

  async loadProjectConfig(): Promise<ProjectConfig> {
    const workspaceDir = this.#projectStore.workspaceDir;
    const projectDir = this.#projectStore.getProjectDir(this.#currentProject);

    const globalClaudeMd = await this.#readFileOrEmpty(
      path.join(workspaceDir, '_global', 'CLAUDE.md'),
    );
    const projectClaudeMd = this.#currentProject !== '_global'
      ? await this.#readFileOrEmpty(path.join(projectDir, 'CLAUDE.md'))
      : '';
    const systemPrompt = [globalClaudeMd, projectClaudeMd].filter(Boolean).join('\n\n');

    const globalMcpRaw = await this.#readJsonOrEmpty(
      path.join(workspaceDir, '_global', '.mcp.json'),
    );
    const projectMcpRaw = this.#currentProject !== '_global'
      ? await this.#readJsonOrEmpty(path.join(projectDir, '.mcp.json'))
      : {};
    // Unwrap standard .mcp.json format (has mcpServers wrapper) or use flat format
    const globalMcp = (globalMcpRaw.mcpServers || globalMcpRaw) as Record<string, unknown>;
    const projectMcp = (projectMcpRaw.mcpServers || projectMcpRaw) as Record<string, unknown>;
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
