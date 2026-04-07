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
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: 1.2, // Wait 1.2s of silence before end-of-speech (default 0.55)
    });
  },

  entry: async (ctx: JobContext) => {
    // Helper to send events to web client
    function sendEvent(event: Record<string, unknown>) {
      const data = new TextEncoder().encode(JSON.stringify(event));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    }

    // Claude Agent SDK handler — lives outside the LiveKit pipeline
    const claude = new AgentSDKHandler({
      model: 'claude-sonnet-4-6',
      onEvent: sendEvent,
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
        payload.sttDuration = m.durationMs;
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
      claude.close();
    });

    // --- Core: STT transcript → Agent SDK → TTS via say() ---

    let processing = false;

    agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);
      if (ev.isFinal) {
        sendEvent({ type: 'stt', transcript: ev.transcript });
      }

      if (!ev.isFinal || !ev.transcript.trim()) return;

      // If we're already processing, abort previous (barge-in)
      if (processing) {
        console.log('[Agent] Barge-in detected, interrupting previous response');
        claude.interrupt();
      }

      processing = true;
      const userText = ev.transcript.trim();

      // Smart buffering: collect fast sentences, flush on pause or tool call
      let buffer: string[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let firstSentenceAt: number | null = null;
      const COALESCE_MS = 200;  // Wait this long after each sentence for more
      const MAX_WAIT_MS = 1500; // Max time from first buffered sentence to flush

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
        // How long since first sentence in buffer?
        const elapsed = firstSentenceAt ? Date.now() - firstSentenceAt : 0;
        const remaining = Math.max(0, MAX_WAIT_MS - elapsed);
        // Flush after coalesce timeout or max wait, whichever is shorter
        const delay = Math.min(COALESCE_MS, remaining);
        flushTimer = setTimeout(flush, delay);
      };

      claude.sendAndStream(userText, (sentence) => {
        if (firstSentenceAt === null) firstSentenceAt = Date.now();
        buffer.push(sentence);
        scheduleFlush();
      }, () => {
        // Tool call callback — flush immediately so user hears intent before tool runs
        flush();
      }).then(() => {
        // Flush any remaining buffered text
        flush();
      }).catch((err) => {
        console.error('[Agent] Agent SDK error:', err);
        sendEvent({ type: 'agent_sdk', event: 'error', error: String(err) });
      }).finally(() => {
        processing = false;
      });
    });

    // Start pipeline and wait for user
    await agentSession.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  shutdownProcessTimeout: 3, // Fast cleanup so reconnect works quickly (default 10s)
  maxRetry: 999999, // Retry connecting to LiveKit effectively forever
}));
