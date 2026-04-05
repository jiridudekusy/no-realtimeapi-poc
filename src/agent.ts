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
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        'You are a helpful voice assistant. Respond concisely. You speak Czech and English — respond in the language the user speaks.',
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'multi',
      }),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
      }),
      tts: new deepgram.TTS({
        model: 'aura-asteria-en',
      }),
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`Agent state: ${ev.oldState} -> ${ev.newState}`);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`User (final=${ev.isFinal}): ${ev.transcript}`);
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      console.log('Metrics:', JSON.stringify(ev.metrics));
    });

    await session.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();

    session.generateReply({
      instructions: 'Greet the user briefly and ask how you can help.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
