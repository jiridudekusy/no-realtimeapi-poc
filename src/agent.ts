import 'dotenv/config';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as silero from '@livekit/agents-plugin-silero';
import * as openai from '@livekit/agents-plugin-openai';
import { SYSTEM_INSTRUCTIONS } from './plugins/agent-sdk-handler.js';
import { loadPipelineConfig, type PipelineConfig } from './pipeline-config.js';
import { createLLMHandler } from './plugins/llm-factory.js';
import type { LLMHandler } from './plugins/llm-handler.js';
import { type SessionMessage, type SessionData } from './session-store.js';
import { ProjectStore } from './project-store.js';
import { ProjectContext } from './project-context.js';
import { initWorkspace, migrateOldSessions } from './workspace-init.js';
import { createNavigationMcpServer, NAVIGATION_TOOL_NAMES } from './mcp/navigation-server.js';
import { createNavigationHandler } from './navigation-handler.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    const workspaceDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'workspace');
    const pipelineConfig = await loadPipelineConfig(workspaceDir);
    proc.userData.pipelineConfig = pipelineConfig;
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: pipelineConfig.vad.minSilenceDuration ?? 1.5,
    });
  },

  entry: async (ctx: JobContext) => {
    // Helper to send events to web client
    function sendEvent(event: Record<string, unknown>) {
      const data = new TextEncoder().encode(JSON.stringify(event));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    }

    // Pipeline config from prewarm
    const pipelineConfig = ctx.proc.userData.pipelineConfig as PipelineConfig;

    // Workspace + project context
    const workspaceDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'workspace');
    await initWorkspace(workspaceDir);

    const oldSessionsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data', 'sessions');
    await migrateOldSessions(oldSessionsDir, workspaceDir);

    const projectStore = new ProjectStore(workspaceDir);
    await projectStore.init();

    const projectCtx = new ProjectContext(projectStore, '_global');
    await projectCtx.init();

    async function ensureSession(): Promise<SessionData> {
      if (!projectCtx.currentSession) {
        projectCtx.currentSession = await projectCtx.sessionStore.createSession();
        console.log(`[Agent] New session created: ${projectCtx.currentSession.sessionId}`);
        sendEvent({ type: 'session_info', sessionId: projectCtx.currentSession.sessionId, projectName: projectCtx.currentProject });
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
      const msg: SessionMessage = {
        role: 'assistant',
        text,
        timestamp: new Date().toISOString(),
      };
      await projectCtx.sessionStore.addMessage(session.sessionId, msg);
    }

    async function handleToolCall(name: string, input: string) {
      const session = await ensureSession();
      const msg: SessionMessage = {
        role: 'tool',
        text: `${name}: ${input}`,
        timestamp: new Date().toISOString(),
        name,
        input,
      };
      await projectCtx.sessionStore.addMessage(session.sessionId, msg);
    }

    // Voice lock file
    const voiceLockFile = path.join(workspaceDir, '.voice-lock.json');
    const { writeFile } = await import('node:fs/promises');

    async function updateVoiceLock() {
      const lock = projectCtx.currentSession
        ? { projectName: projectCtx.currentProject, sessionId: projectCtx.currentSession.sessionId }
        : null;
      await writeFile(voiceLockFile, JSON.stringify(lock), 'utf-8');
    }

    // Deferred context switch — set during MCP tool callback, executed after turn completes
    let pendingSwitch: { projectName: string; sessionId: string | null } | null = null;

    async function performContextSwitch(projectName: string, sessionId: string | null) {
      // Don't switch mid-query — defer until turn completes
      pendingSwitch = { projectName, sessionId };
      console.log(`[Agent] Context switch queued: ${projectName}/${sessionId || 'new'}`);
    }

    async function executePendingSwitch() {
      if (!pendingSwitch) return;
      const { projectName, sessionId } = pendingSwitch;
      pendingSwitch = null;

      claude.close();

      await projectCtx.switchTo(projectName, sessionId || undefined);

      const config = await projectCtx.loadProjectConfig();
      const projectInfo = projectName === '_global'
        ? 'You are in the HOME space (no project).'
        : `You are in project "${projectName}".`;
      const navPrompt = `${projectInfo}\nWhen switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation.`;
      const fullPrompt = [SYSTEM_INSTRUCTIONS, config.systemPrompt, navPrompt].filter(Boolean).join('\n\n');

      const navServer = createNavigationMcpServer(navHandler);

      const switchPipelineConfig = await loadPipelineConfig(workspaceDir, projectName);
      claude = createLLMHandler(switchPipelineConfig.llm, {
        cwd: config.cwd,
        systemPrompt: fullPrompt,
        claudeSessionId: projectCtx.currentSession?.claudeSessionId || undefined,
        mcpServers: { navigation: navServer, ...config.mcpConfig },
        additionalAllowedTools: NAVIGATION_TOOL_NAMES,
        onEvent: sendEvent,
        onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
        onAssistantMessage: (text) => handleAssistantMessage(text),
        onToolCall: (name, input) => handleToolCall(name, input),
        navigationHandler: navHandler,
        messageHistory: [],
      });

      await updateVoiceLock();

      console.log(`[Agent] Context switched to ${projectName}/${sessionId || 'new'} (claude: ${projectCtx.currentSession?.claudeSessionId || 'none'})`);

      sendEvent({
        type: 'context_switched',
        projectName: projectCtx.currentProject,
        sessionId: projectCtx.currentSession?.sessionId || null,
      });
    }

    const navHandler = createNavigationHandler(projectStore, projectCtx, performContextSwitch);

    // Claude Agent SDK handler — lives outside the LiveKit pipeline
    const initialConfig = await projectCtx.loadProjectConfig();
    const navPrompt = 'When switching projects or chats, ALWAYS confirm with the user before calling switch_chat, new_chat, go_back, or go_home. Tell them what will happen and ask for confirmation.';
    const initialPrompt = [SYSTEM_INSTRUCTIONS, initialConfig.systemPrompt, navPrompt].filter(Boolean).join('\n\n');
    const navServer = createNavigationMcpServer(navHandler);

    let claude: LLMHandler = createLLMHandler(pipelineConfig.llm, {
      cwd: initialConfig.cwd,
      systemPrompt: initialPrompt,
      mcpServers: { navigation: navServer, ...initialConfig.mcpConfig },
      additionalAllowedTools: NAVIGATION_TOOL_NAMES,
      onEvent: sendEvent,
      onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
      onAssistantMessage: (text) => handleAssistantMessage(text),
      onToolCall: (name, input) => handleToolCall(name, input),
      navigationHandler: navHandler,
      messageHistory: [],
    });

    // LiveKit pipeline: VAD + STT + TTS only, NO LLM
    const agent = new voice.Agent({ instructions: '' });

    const agentSession = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: (pipelineConfig.stt.model || 'nova-3') as 'nova-3',
        language: (pipelineConfig.stt.language as string) || 'cs',
      }),
      tts: new openai.TTS({
        model: (pipelineConfig.tts.model as string) || 'tts-1',
        voice: (pipelineConfig.tts.voice || 'nova') as 'nova',
      }),
      // No LLM — we handle it ourselves via Agent SDK
    });

    // --- Event forwarding ---

    agentSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`Agent state: ${ev.oldState} -> ${ev.newState}`);
      sendEvent({ type: 'state', oldState: ev.oldState, newState: ev.newState });
    });

    agentSession.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      const payload: Record<string, unknown> = { type: 'metrics' };
      if (m.type === 'stt_metrics') {
        // sttDuration computed in UserInputTranscribed handler (first partial → final)
        // LiveKit's durationMs is always 0 for streaming Deepgram STT
        payload.sttAudioMs = m.audioDurationMs;
      } else if (m.type === 'tts_metrics') {
        payload.ttsDuration = m.durationMs;
        payload.ttsChars = m.charactersCount;
      }
      sendEvent(payload);
    });

    agentSession.on(voice.AgentSessionEventTypes.Close, async (ev) => {
      console.log('Session closed:', ev.reason, ev.error);
      sendEvent({ type: 'error', reason: ev.reason, error: ev.error ? String(ev.error) : null });
      claude.interrupt();
      await writeFile(voiceLockFile, 'null', 'utf-8').catch(() => {});
    });

    // --- LLM Hold: buffer transcripts until released ---

    let llmHeld = false;
    let heldTranscripts: string[] = [];

    // Listen for hold/release data messages from web client
    ctx.room.on('dataReceived', async (data: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(data));
        console.log(`[Agent] Data received: ${msg.type}`);
        if (msg.type === 'llm_hold') {
          llmHeld = msg.held;
          console.log(`[Agent] LLM hold: ${llmHeld ? 'ON' : 'OFF'}`);
          if (!llmHeld && heldTranscripts.length > 0) {
            // Release — send all buffered transcripts as one message
            const combined = heldTranscripts.join(' ');
            heldTranscripts = [];
            console.log(`[Agent] Releasing held transcripts: ${combined.slice(0, 80)}...`);
            processUserText(combined);
          }
        }
        if (msg.type === 'session_init') {
          const projectName = (msg.projectName as string) || '_global';
          const sessionId = msg.sessionId as string | undefined;
          console.log(`[Agent] session_init: project=${projectName}, session=${sessionId}`);
          await performContextSwitch(projectName, sessionId || null);
        }
      } catch (err) {
        console.error('[Agent] dataReceived error:', err);
      }
    });

    // --- Core: STT transcript → Agent SDK → TTS via say() ---

    let processing = false;

    function processUserText(userText: string) {
      ensureSession().then(session => {
        const userMsg: SessionMessage = {
          role: 'user',
          text: userText,
          timestamp: new Date().toISOString(),
        };
        return projectCtx.sessionStore.addMessage(session.sessionId, userMsg);
      }).catch(err =>
        console.error('[Agent] Failed to persist user message:', err)
      );

      sendEvent({ type: 'thinking' });

      // If we're already processing, abort previous (barge-in)
      if (processing) {
        console.log('[Agent] Barge-in detected, interrupting previous response');
        claude.interrupt();
      }
      processing = true;

      // Smart buffering: collect fast sentences, flush on pause or tool call
      let buffer: string[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let firstSentenceAt: number | null = null;
      const COALESCE_MS = 200;
      const MAX_WAIT_MS = 1500;

      const flush = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (buffer.length === 0) return;
        const text = buffer.join(' ');
        buffer = [];
        firstSentenceAt = null;
        console.log(`[Agent] Say (${text.length}ch): ${text.slice(0, 80)}...`);
        agentSession.say(text, { allowInterruptions: true, addToChatCtx: false });
      };

      const scheduleFlush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        const elapsed = firstSentenceAt ? Date.now() - firstSentenceAt : 0;
        const remaining = Math.max(0, MAX_WAIT_MS - elapsed);
        const delay = Math.min(COALESCE_MS, remaining);
        flushTimer = setTimeout(flush, delay);
      };

      claude.sendAndStream(userText, (sentence) => {
        if (firstSentenceAt === null) firstSentenceAt = Date.now();
        buffer.push(sentence);
        scheduleFlush();
      }, () => {
        flush();
      }).then(() => {
        flush();
      }).catch((err) => {
        console.error('[Agent] Agent SDK error:', err);
        sendEvent({ type: 'agent_sdk', event: 'error', error: String(err) });
      }).finally(async () => {
        processing = false;
        await executePendingSwitch();
      });
    }

    let sttStartTime: number | null = null;
    let pendingTranscript = '';
    let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
    const TRANSCRIPT_COALESCE_MS = 2000; // Wait 2s after last final transcript before sending to Claude

    agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);

      // Track STT latency: first partial → final transcript
      if (!ev.isFinal && !sttStartTime) {
        sttStartTime = Date.now();
      }

      if (ev.isFinal) {
        if (sttStartTime) {
          const sttLatency = Date.now() - sttStartTime;
          sendEvent({ type: 'metrics', sttDuration: sttLatency });
          sttStartTime = null;
        }
        sendEvent({ type: 'stt', transcript: ev.transcript });
      }

      // Reset coalesce timer on ANY transcript (partial = user still speaking)
      if (transcriptTimer) clearTimeout(transcriptTimer);

      if (!ev.isFinal || !ev.transcript.trim()) {
        // Partial — just reset timer, don't append
        if (pendingTranscript) {
          transcriptTimer = setTimeout(() => {
            const text = pendingTranscript;
            pendingTranscript = '';
            transcriptTimer = null;
            console.log(`[Agent] Coalesced transcript: ${text.slice(0, 80)}`);
            processUserText(text);
          }, TRANSCRIPT_COALESCE_MS);
        }
        return;
      }

      if (llmHeld) {
        heldTranscripts.push(ev.transcript.trim());
        console.log(`[Agent] Held transcript (${heldTranscripts.length}): ${ev.transcript.trim()}`);
        return;
      }

      // Append final transcript and schedule send
      pendingTranscript += (pendingTranscript ? ' ' : '') + ev.transcript.trim();
      transcriptTimer = setTimeout(() => {
        const text = pendingTranscript;
        pendingTranscript = '';
        transcriptTimer = null;
        console.log(`[Agent] Coalesced transcript: ${text.slice(0, 80)}`);
        processUserText(text);
      }, TRANSCRIPT_COALESCE_MS);
    });

    // Start pipeline and wait for user
    await agentSession.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();
    // Signal that agent is ready — web client uses this to send session_init for resume
    sendEvent({
      type: 'session_info',
      sessionId: projectCtx.currentSession?.sessionId ?? null,
      projectName: projectCtx.currentProject,
    });
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  shutdownProcessTimeout: 3, // Fast cleanup so reconnect works quickly (default 10s)
  maxRetry: 999999, // Retry connecting to LiveKit effectively forever
}));
