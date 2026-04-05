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
import { AgentLLM } from './plugins/agent-llm.js';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: '',
    });

    // Helper to send events to web client
    function sendEvent(event: Record<string, unknown>) {
      const data = new TextEncoder().encode(JSON.stringify(event));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'cs',
      }),
      llm: new AgentLLM({
        model: 'claude-sonnet-4-6',
        onEvent: sendEvent,
      }),
      tts: new openai.TTS({
        model: 'tts-1',
        voice: 'nova',
      }),
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`Agent state: ${ev.oldState} -> ${ev.newState}`);
      sendEvent({ type: 'state', oldState: ev.oldState, newState: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);
      if (ev.isFinal) {
        sendEvent({ type: 'stt', transcript: ev.transcript });
      }
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      console.log('Metrics:', JSON.stringify(ev.metrics));
      const m = ev.metrics;
      const payload: Record<string, unknown> = { type: 'metrics' };
      if (m.type === 'stt_metrics') {
        payload.sttDuration = m.durationMs;
        payload.sttAudioMs = m.audioDurationMs;
      } else if (m.type === 'llm_metrics') {
        payload.llmDuration = m.durationMs;
        payload.llmPromptTokens = m.promptTokens;
        payload.llmCompletionTokens = m.completionTokens;
        payload.llmTotalTokens = m.totalTokens;
        payload.llmTokensPerSec = m.tokensPerSecond;
      } else if (m.type === 'tts_metrics') {
        payload.ttsDuration = m.durationMs;
        payload.ttsChars = m.charactersCount;
      }
      sendEvent(payload);
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.log('Session closed:', ev.reason, ev.error);
      sendEvent({ type: 'error', reason: ev.reason, error: ev.error ? String(ev.error) : null });
    });

    await session.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();

    session.generateReply({
      instructions: 'Greet the user briefly and ask how you can help.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
