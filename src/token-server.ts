import 'dotenv/config';
import express from 'express';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './session-store.js';
import { AgentSDKHandler } from './plugins/agent-sdk-handler.js';
import type { SessionMessage } from './session-store.js';

const app = express();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..', 'web');

const sessionStore = new SessionStore(
  path.resolve(__dirname, '..', 'data', 'sessions'),
);
await sessionStore.init();

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

app.get('/api/sessions', async (req, res) => {
  try {
    const q = req.query.q as string | undefined;
    const sessions = await sessionStore.listSessions(q);
    res.json(sessions);
  } catch (err) {
    console.error('Failed to list sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('Failed to get session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await sessionStore.setName(req.params.id, name);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to update session:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

app.post('/api/sessions/:id/generate-name', async (req, res) => {
  try {
    const session = await sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Build a summary of the conversation for name generation
    const transcript = session.messages
      .filter(m => m.role !== 'tool')
      .slice(0, 10) // first 10 messages max
      .map(m => `${m.role}: ${m.text}`)
      .join('\n');

    const claude = new AgentSDKHandler({
      model: 'claude-haiku-4-5',
    });

    let generatedName = '';
    await claude.sendAndStream(
      `Generate a short title (3-6 words, no quotes) for this conversation:\n\n${transcript}`,
      (sentence) => { generatedName += sentence + ' '; },
    );
    claude.close();

    const name = generatedName.trim().slice(0, 60);
    await sessionStore.setName(session.sessionId, name);
    res.json({ name });
  } catch (err) {
    console.error('Failed to generate name:', err);
    res.status(500).json({ error: 'Failed to generate name' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { text, sessionId } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  // Load or create session
  let session;
  if (sessionId) {
    session = await sessionStore.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
  } else {
    session = await sessionStore.createSession();
  }

  // Persist user message
  const userMsg: SessionMessage = {
    role: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
  await sessionStore.addMessage(session.sessionId, userMsg);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send session info immediately
  res.write(`data: ${JSON.stringify({ type: 'session_info', sessionId: session.sessionId })}\n\n`);

  // Create handler for this request
  const claude = new AgentSDKHandler({
    model: 'claude-sonnet-4-6',
    claudeSessionId: session.claudeSessionId || undefined,
    onEvent: (event) => {
      // Forward events to client for server event log
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    },
    onSessionIdCaptured: async (claudeSessionId) => {
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await sessionStore.setClaudeSessionId(session.sessionId, claudeSessionId);
        console.log(`[Chat] Session ${session.sessionId} linked to Claude: ${claudeSessionId}`);
      }
    },
    onAssistantMessage: async (fullText) => {
      const assistMsg: SessionMessage = {
        role: 'assistant',
        text: fullText,
        timestamp: new Date().toISOString(),
      };
      await sessionStore.addMessage(session.sessionId, assistMsg);
    },
    onToolCall: async (name, input) => {
      const toolMsg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await sessionStore.addMessage(session.sessionId, toolMsg);
    },
  });

  try {
    await claude.sendAndStream(text, (sentence) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text: sentence })}\n\n`);
    }, () => {
      // Tool call — optionally notify client
    });

    res.write(`data: ${JSON.stringify({ type: 'done', sessionId: session.sessionId })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
  } finally {
    claude.close();
    res.end();
  }
});

const PORT = parseInt(process.env.TOKEN_SERVER_PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`Token server running at http://localhost:${PORT}`);
  console.log(`Web client at http://localhost:${PORT}/index.html`);
});
