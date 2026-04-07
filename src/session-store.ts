import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: string;
  name?: string;       // tool name (for role=tool)
  input?: string;      // tool input (for role=tool)
  output?: string;     // tool output (for role=tool)
}

export interface SessionMeta {
  sessionId: string;
  claudeSessionId: string | null;
  created: string;
  updated: string;
  preview: string;
  name: string | null;
  messageCount: number;
}

export interface SessionData {
  sessionId: string;
  claudeSessionId: string | null;
  created: string;
  name: string | null;
  messages: SessionMessage[];
}

export class SessionStore {
  #dir: string;
  #indexPath: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#indexPath = path.join(dir, 'index.json');
  }

  async init(): Promise<void> {
    if (!existsSync(this.#dir)) {
      await mkdir(this.#dir, { recursive: true });
    }
    if (!existsSync(this.#indexPath)) {
      await writeFile(this.#indexPath, '[]', 'utf-8');
    }
  }

  async listSessions(query?: string): Promise<SessionMeta[]> {
    const index = await this.#readIndex();
    // Filter out empty sessions (0 messages)
    let results = index
      .filter(s => s.messageCount > 0)
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

    if (query) {
      const q = query.toLowerCase();
      const matched: SessionMeta[] = [];
      for (const meta of results) {
        if (meta.preview.toLowerCase().includes(q)) {
          matched.push(meta);
          continue;
        }
        const session = await this.getSession(meta.sessionId);
        if (session && session.messages.some(m => m.text.toLowerCase().includes(q))) {
          matched.push(meta);
        }
      }
      results = matched;
    }

    return results;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const filePath = path.join(this.#dir, `${sessionId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as SessionData;
    } catch {
      return null;
    }
  }

  async createSession(): Promise<SessionData> {
    const sessionId = randomUUID();
    const session: SessionData = {
      sessionId,
      claudeSessionId: null,
      created: new Date().toISOString(),
      name: null,
      messages: [],
    };
    await this.#writeSession(session);
    await this.#addToIndex(session);
    return session;
  }

  async addMessage(sessionId: string, message: SessionMessage): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.messages.push(message);
    await this.#writeSession(session);
    await this.#updateIndex(sessionId, {
      updated: new Date().toISOString(),
      messageCount: session.messages.length,
      preview: this.#extractPreview(session),
    });
  }

  async setClaudeSessionId(sessionId: string, claudeSessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.claudeSessionId = claudeSessionId;
    await this.#writeSession(session);
    await this.#updateIndex(sessionId, { claudeSessionId });
  }

  async setName(sessionId: string, name: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.name = name;
    await this.#writeSession(session);
    await this.#updateIndex(sessionId, { name });
  }

  #extractPreview(session: SessionData): string {
    const firstUserMsg = session.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return '(empty)';
    return firstUserMsg.text.length > 50
      ? firstUserMsg.text.slice(0, 50) + '...'
      : firstUserMsg.text;
  }

  async #readIndex(): Promise<SessionMeta[]> {
    try {
      const data = await readFile(this.#indexPath, 'utf-8');
      return JSON.parse(data) as SessionMeta[];
    } catch {
      return [];
    }
  }

  async #writeIndex(index: SessionMeta[]): Promise<void> {
    await writeFile(this.#indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  async #writeSession(session: SessionData): Promise<void> {
    const filePath = path.join(this.#dir, `${session.sessionId}.json`);
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  async #addToIndex(session: SessionData): Promise<void> {
    const index = await this.#readIndex();
    index.push({
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      created: session.created,
      updated: session.created,
      preview: '(new session)',
      name: session.name,
      messageCount: 0,
    });
    await this.#writeIndex(index);
  }

  async #updateIndex(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
    const index = await this.#readIndex();
    const entry = index.find(e => e.sessionId === sessionId);
    if (entry) {
      Object.assign(entry, updates);
      await this.#writeIndex(index);
    }
  }
}
