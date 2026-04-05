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
        console.log('[Agent] Barge-in detected, aborting previous response');
        claude.abort();
      }

      processing = true;
      const userText = ev.transcript.trim();

      claude.sendAndStream(userText, (sentence) => {
        console.log(`[Agent] Say: ${sentence.slice(0, 60)}...`);
        agentSession.say(sentence, { allowInterruptions: true, addToChatCtx: false });
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

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
