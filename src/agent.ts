/**
 * LiveKit voice agent — thin wrapper around AgentCore.
 * Handles VAD/STT/TTS pipeline and transcript coalescing.
 * All business logic (LLM, navigation, sessions) lives in AgentCore.
 */
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
import { loadPipelineConfig, type PipelineConfig } from './pipeline-config.js';
import { AgentCore } from './agent-core.js';
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
    const pipelineConfig = ctx.proc.userData.pipelineConfig as PipelineConfig;
    const workspaceDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'workspace');

    // --- LiveKit event sender ---
    function sendEvent(event: Record<string, unknown>) {
      const data = new TextEncoder().encode(JSON.stringify(event));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    }

    // --- LiveKit pipeline: VAD + STT + TTS (no LLM) ---
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
    });

    // --- AgentCore: all business logic ---
    const core = new AgentCore({
      workspaceDir,
      pipelineConfig,
      callbacks: {
        onEvent: sendEvent,
        onSay: (text) => {
          console.log(`[Agent] Say (${text.length}ch): ${text.slice(0, 80)}...`);
        },
        onSpeechStream: (stream) => {
          console.log('[Agent] Speech stream → agentSession.say(stream)');
          agentSession.say(stream as any, { allowInterruptions: true, addToChatCtx: false });
        },
      },
    });
    await core.init();

    // --- Voice lock ---
    const voiceLockFile = path.join(workspaceDir, '.voice-lock.json');
    const { writeFile } = await import('node:fs/promises');

    async function updateVoiceLock() {
      const lock = core.currentSession
        ? { projectName: core.currentProject, sessionId: core.currentSession.sessionId }
        : null;
      await writeFile(voiceLockFile, JSON.stringify(lock), 'utf-8');
    }

    // --- Event forwarding ---
    agentSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`Agent state: ${ev.oldState} -> ${ev.newState}`);
      sendEvent({ type: 'state', oldState: ev.oldState, newState: ev.newState });
    });

    agentSession.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      const payload: Record<string, unknown> = { type: 'metrics' };
      if (m.type === 'stt_metrics') {
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
      core.interrupt();
      await writeFile(voiceLockFile, 'null', 'utf-8').catch(() => {});
    });

    // --- LLM Hold ---
    let llmHeld = false;
    let heldTranscripts: string[] = [];

    // --- Data messages from web client ---
    ctx.room.on('dataReceived', async (data: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(data));
        console.log(`[Agent] Data received: ${msg.type}`);

        if (msg.type === 'llm_hold') {
          llmHeld = msg.held;
          console.log(`[Agent] LLM hold: ${llmHeld ? 'ON' : 'OFF'}`);
          if (!llmHeld && heldTranscripts.length > 0) {
            const combined = heldTranscripts.join(' ');
            heldTranscripts = [];
            core.processUserText(combined);
          }
        }
        else if (msg.type === 'inject_text') {
          if (msg.text) core.processUserText(msg.text as string);
        }
        else if (msg.type === 'session_init') {
          const projectName = (msg.projectName as string) || '_global';
          const sessionId = msg.sessionId as string | undefined;
          console.log(`[Agent] session_init: project=${projectName}, session=${sessionId}`);
          await core.handleSessionInit(projectName, sessionId);
        }
        else if (msg.type === 'hold_llm') {
          llmHeld = true;
          sendEvent({ type: 'llm_hold_state', held: true });
        }
        else if (msg.type === 'release_llm') {
          llmHeld = false;
          sendEvent({ type: 'llm_hold_state', held: false });
          if (heldTranscripts.length > 0) {
            const combined = heldTranscripts.join(' ');
            heldTranscripts = [];
            core.processUserText(combined);
          }
        }
      } catch (err) {
        console.error('[Agent] dataReceived error:', err);
      }
    });

    // --- Transcript coalescing: STT → AgentCore ---
    let sttStartTime: number | null = null;
    let pendingTranscript = '';
    let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
    const TRANSCRIPT_COALESCE_MS = 2000;

    agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);

      if (!ev.isFinal && !sttStartTime) sttStartTime = Date.now();

      if (ev.isFinal) {
        if (sttStartTime) {
          sendEvent({ type: 'metrics', sttDuration: Date.now() - sttStartTime });
          sttStartTime = null;
        }
        sendEvent({ type: 'stt', transcript: ev.transcript });
      }

      if (transcriptTimer) clearTimeout(transcriptTimer);

      if (!ev.isFinal || !ev.transcript.trim()) {
        if (pendingTranscript) {
          transcriptTimer = setTimeout(() => {
            const text = pendingTranscript;
            pendingTranscript = '';
            transcriptTimer = null;
            console.log(`[Agent] Coalesced transcript: ${text.slice(0, 80)}`);
            core.processUserText(text);
          }, TRANSCRIPT_COALESCE_MS);
        }
        return;
      }

      if (llmHeld) {
        heldTranscripts.push(ev.transcript.trim());
        console.log(`[Agent] Held transcript (${heldTranscripts.length}): ${ev.transcript.trim()}`);
        return;
      }

      pendingTranscript += (pendingTranscript ? ' ' : '') + ev.transcript.trim();
      transcriptTimer = setTimeout(() => {
        const text = pendingTranscript;
        pendingTranscript = '';
        transcriptTimer = null;
        console.log(`[Agent] Coalesced transcript: ${text.slice(0, 80)}`);
        core.processUserText(text);
      }, TRANSCRIPT_COALESCE_MS);
    });

    // --- Start ---
    await agentSession.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();
    sendEvent({
      type: 'session_info',
      sessionId: core.currentSession?.sessionId ?? null,
      projectName: core.currentProject,
    });
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  shutdownProcessTimeout: 3,
  maxRetry: 999999,
}));
