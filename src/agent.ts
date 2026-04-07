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
import { AgentSDKHandler } from './plugins/agent-sdk-handler.js';
import { SessionStore, type SessionMessage, type SessionData } from './session-store.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: 1.5, // Wait 1.5s of silence before end-of-speech (default 0.55)
    });
  },

  entry: async (ctx: JobContext) => {
    // Helper to send events to web client
    function sendEvent(event: Record<string, unknown>) {
      const data = new TextEncoder().encode(JSON.stringify(event));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    }

    // Session store
    const sessionStore = new SessionStore(
      path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data', 'sessions'),
    );
    await sessionStore.init();

    let currentSession: SessionData | null = null;

    async function ensureSession(): Promise<SessionData> {
      if (!currentSession) {
        currentSession = await sessionStore.createSession();
        console.log(`[Agent] New session created: ${currentSession.sessionId}`);
        sendEvent({ type: 'session_info', sessionId: currentSession.sessionId });
      }
      return currentSession;
    }

    async function handleSessionIdCaptured(claudeSessionId: string) {
      const session = await ensureSession();
      if (!session.claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
        await sessionStore.setClaudeSessionId(session.sessionId, claudeSessionId);
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
      await sessionStore.addMessage(session.sessionId, msg);
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
      await sessionStore.addMessage(session.sessionId, msg);
    }

    // Claude Agent SDK handler — lives outside the LiveKit pipeline
    let claude = new AgentSDKHandler({
      model: 'claude-sonnet-4-6',
      onEvent: sendEvent,
      onSessionIdCaptured: (id) => handleSessionIdCaptured(id),
      onAssistantMessage: (text) => handleAssistantMessage(text),
      onToolCall: (name, input) => handleToolCall(name, input),
    });

    // LiveKit pipeline: VAD + STT + TTS only, NO LLM
    const agent = new voice.Agent({ instructions: '' });

    const agentSession = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({ model: 'nova-3', language: 'cs' }),
      tts: new openai.TTS({ model: 'tts-1', voice: 'nova' }),
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

    agentSession.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.log('Session closed:', ev.reason, ev.error);
      sendEvent({ type: 'error', reason: ev.reason, error: ev.error ? String(ev.error) : null });
      claude.interrupt();
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
        if (msg.type === 'session_init' && msg.sessionId) {
          console.log(`[Agent] session_init received for: ${msg.sessionId}`);
          const existing = await sessionStore.getSession(msg.sessionId as string);
          console.log(`[Agent] Session lookup: ${existing ? `found (claude: ${existing.claudeSessionId})` : 'NOT FOUND'}`);
          if (existing) {
            currentSession = existing;
            console.log(`[Agent] Resuming session: ${existing.sessionId} (claude: ${existing.claudeSessionId})`);
            claude.close();
            claude = new AgentSDKHandler({
              model: 'claude-sonnet-4-6',
              claudeSessionId: existing.claudeSessionId || undefined,
              onEvent: sendEvent,
              onAssistantMessage: (text) => handleAssistantMessage(text),
              onToolCall: (name, input) => handleToolCall(name, input),
            });
            sendEvent({ type: 'session_info', sessionId: existing.sessionId });
          }
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
        return sessionStore.addMessage(session.sessionId, userMsg);
      }).catch(err =>
        console.error('[Agent] Failed to persist user message:', err)
      );

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
      }).finally(() => {
        processing = false;
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
    sendEvent({ type: 'session_info', sessionId: (currentSession as SessionData | null)?.sessionId ?? null });
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  shutdownProcessTimeout: 3, // Fast cleanup so reconnect works quickly (default 10s)
  maxRetry: 999999, // Retry connecting to LiveKit effectively forever
}));
