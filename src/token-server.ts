import 'dotenv/config';
import express from 'express';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat } from 'node:fs/promises';
import multer from 'multer';
import { SessionStore } from './session-store.js';
import { AgentSDKHandler } from './plugins/agent-sdk-handler.js';
import type { SessionMessage } from './session-store.js';
import { createNavigationMcpServer, NAVIGATION_TOOL_NAMES } from './mcp/navigation-server.js';
import { ProjectStore } from './project-store.js';
import { initWorkspace } from './workspace-init.js';
import { loadPipelineConfig } from './pipeline-config.js';
import { createLLMHandler } from './plugins/llm-factory.js';

const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..', 'web');

const workspaceDir = path.resolve(__dirname, '..', 'workspace');
await initWorkspace(workspaceDir);

const projectStore = new ProjectStore(workspaceDir);
await projectStore.init();

function getSessionStore(projectName: string): SessionStore {
  return new SessionStore(projectStore.getSessionsDir(projectName || '_global'));
}

app.use(express.static(webDir));
app.use(express.json());

app.get('/api/token', async (req, res) => {
  const room = (req.query.room as string) || `voice-${Date.now()}`;
  const identity = (req.query.identity as string) || `user-${Date.now()}`;
  console.log(`Token requested: room=${room}, identity=${identity}`);

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity, ttl: '6h' },
  );

  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  };

  at.addGrant(grant);
  const token = await at.toJwt();
  res.json({ token });
});

app.get('/api/health', async (_req, res) => {
  try {
    // Check if LiveKit is reachable by creating a test token
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: 'health-check', ttl: '10s' },
    );
    await at.toJwt();
    res.json({ status: 'ok', livekit: process.env.LIVEKIT_URL || 'unknown' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: String(err) });
  }
});

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

app.delete('/api/projects/:name', async (req, res) => {
  try {
    const { confirmName } = req.body;
    if (confirmName !== req.params.name) {
      res.status(400).json({ error: 'Project name confirmation does not match' });
      return;
    }
    await projectStore.deleteProject(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

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

app.delete('/api/projects/:name/sessions/:id', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    await store.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
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

// --- File API ---

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileEntry[];
}

async function listFilesRecursive(dir: string, exclude: string[] = ['sessions']): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (exclude.includes(item.name)) continue;
      if (item.name.startsWith('.claude')) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        const children = await listFilesRecursive(fullPath, []);
        entries.push({ name: item.name, type: 'directory', children });
      } else {
        const stats = await stat(fullPath);
        entries.push({ name: item.name, type: 'file', size: stats.size });
      }
    }
  } catch {}
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

app.get('/api/projects/:name/files', async (req, res) => {
  try {
    const projectDir = projectStore.getProjectDir(req.params.name);
    const files = await listFilesRecursive(projectDir);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.get('/api/projects/:name/files/*filepath', async (req, res) => {
  try {
    const projectDir = projectStore.getProjectDir(req.params.name);
    const fileParam = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
    const filePath = path.join(projectDir, fileParam);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    const projectResolved = path.resolve(projectDir);
    if (!resolved.startsWith(projectResolved)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { existsSync } = await import('node:fs');
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(resolved, { dotfiles: 'allow' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
      const projectDir = projectStore.getProjectDir(name);
      cb(null, projectDir);
    },
    filename: (_req, file, cb) => {
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/projects/:name/files', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }
  res.json({ ok: true, filename: req.file.originalname, size: req.file.size });
});

app.post('/api/chat', async (req, res) => {
  const { text, sessionId, projectName = '_global' } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const store = getSessionStore(projectName);
  await store.init();

  // Check voice lock
  try {
    const lockData = await readFile(path.join(workspaceDir, '.voice-lock.json'), 'utf-8');
    const lock = JSON.parse(lockData);
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

  // Persist user message
  const userMsg: SessionMessage = {
    role: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
  await store.addMessage(session.sessionId, userMsg);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send session info immediately
  res.write(`data: ${JSON.stringify({ type: 'session_info', sessionId: session.sessionId, projectName })}\n\n`);

  // Navigation MCP server for text chat
  const { ProjectContext } = await import('./project-context.js');
  const { createNavigationHandler } = await import('./navigation-handler.js');
  const tempCtx = new ProjectContext(projectStore, projectName);
  await tempCtx.init();
  const navHandler = createNavigationHandler(projectStore, tempCtx, async (proj, sid) => {
    res.write(`data: ${JSON.stringify({ type: 'context_switched', projectName: proj, sessionId: sid })}\n\n`);
  });
  const navServer = createNavigationMcpServer(navHandler);

  // Load pipeline config for this project
  const chatPipelineConfig = await loadPipelineConfig(workspaceDir, projectName);

  // Build message history for non-Claude backends
  const history = (session.messages || [])
    .filter((m: SessionMessage) => m.role !== 'tool')
    .map((m: SessionMessage) => ({ role: m.role, text: m.text }));

  // Create handler for this request
  const claude = createLLMHandler(chatPipelineConfig.llm, {
    claudeSessionId: session.claudeSessionId || undefined,
    mcpServers: { navigation: navServer },
    additionalAllowedTools: NAVIGATION_TOOL_NAMES,
    navigationHandler: navHandler,
    messageHistory: history,
    onEvent: (event) => {
      // Forward events to client for server event log
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    },
    onSessionIdCaptured: async (claudeSessionId) => {
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await store.setClaudeSessionId(session.sessionId, claudeSessionId);
        console.log(`[Chat] Session ${session.sessionId} linked to Claude: ${claudeSessionId}`);
      }
    },
    onAssistantMessage: async (fullText) => {
      const assistMsg: SessionMessage = {
        role: 'assistant',
        text: fullText,
        timestamp: new Date().toISOString(),
      };
      await store.addMessage(session.sessionId, assistMsg);
    },
    onToolCall: async (name, input) => {
      const toolMsg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await store.addMessage(session.sessionId, toolMsg);
    },
  });

  try {
    await claude.sendAndStream(text, (sentence) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text: sentence })}\n\n`);
    }, () => {
      // Tool call — optionally notify client
    });

    res.write(`data: ${JSON.stringify({ type: 'done', sessionId: session.sessionId, projectName })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
  } finally {
    claude.close();
    res.end();
  }
});

// --- Sync chat endpoint (JSON request/response, for programmatic use) ---

app.post('/api/projects/:name/chat', async (req, res) => {
  const projectName = req.params.name;
  const { text, sessionId } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const store = getSessionStore(projectName);
  await store.init();

  // Check voice lock
  try {
    const lockData = await readFile(path.join(workspaceDir, '.voice-lock.json'), 'utf-8');
    const lock = JSON.parse(lockData);
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

  // Persist user message
  const userMsg: SessionMessage = {
    role: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
  await store.addMessage(session.sessionId, userMsg);

  // Navigation MCP server
  const { ProjectContext } = await import('./project-context.js');
  const { createNavigationHandler } = await import('./navigation-handler.js');
  const tempCtx = new ProjectContext(projectStore, projectName);
  await tempCtx.init();
  const navHandler = createNavigationHandler(projectStore, tempCtx, async () => {});
  const navServer = createNavigationMcpServer(navHandler);

  // Load pipeline config for this project
  const syncPipelineConfig = await loadPipelineConfig(workspaceDir, projectName);

  // Build message history for non-Claude backends
  const syncHistory = (session.messages || [])
    .filter((m: SessionMessage) => m.role !== 'tool')
    .map((m: SessionMessage) => ({ role: m.role, text: m.text }));

  // Collect full response
  const sentences: string[] = [];

  const claude = createLLMHandler(syncPipelineConfig.llm, {
    claudeSessionId: session.claudeSessionId || undefined,
    mcpServers: { navigation: navServer },
    additionalAllowedTools: NAVIGATION_TOOL_NAMES,
    navigationHandler: navHandler,
    messageHistory: syncHistory,
    onSessionIdCaptured: async (claudeSessionId) => {
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await store.setClaudeSessionId(session.sessionId, claudeSessionId);
      }
    },
    onAssistantMessage: async (fullText) => {
      const assistMsg: SessionMessage = {
        role: 'assistant',
        text: fullText,
        timestamp: new Date().toISOString(),
      };
      await store.addMessage(session.sessionId, assistMsg);
    },
    onToolCall: async (name, input) => {
      const toolMsg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await store.addMessage(session.sessionId, toolMsg);
    },
  });

  try {
    await claude.sendAndStream(text, (sentence) => {
      sentences.push(sentence);
    });

    res.json({
      text: sentences.join(' '),
      sessionId: session.sessionId,
      projectName,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    claude.close();
  }
});

const PORT = parseInt(process.env.TOKEN_SERVER_PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`Token server running at http://localhost:${PORT}`);
  console.log(`Web client at http://localhost:${PORT}/index.html`);
});
