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
      instructions: `You are a helpful voice assistant. Respond concisely. You speak Czech and English — respond in the language the user speaks.

IMPORTANT: Your text output is read aloud by a text-to-speech engine. Format everything for spoken delivery:
- No markdown formatting (no **, no #, no bullet points)
- Write numbers as words: "dva stupně Celsia" not "2 °C", "pět set" not "500"
- You CAN use lists, but write them as spoken language: "zaprvé... zadruhé... zatřetí..." not "1. 2. 3."
- No special characters, symbols, or abbreviations — spell everything out phonetically
- Write units as words: "kilogramů" not "kg", "procent" not "%"
- Spell out acronyms letter by letter with spaces: "A P I" not "API", "H T T P" not "HTTP", "U R L" not "URL"
- No URLs — describe the source instead`,
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'cs',
      }),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
      }),
      tts: new openai.TTS({
        model: 'tts-1',
        voice: 'nova',
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
      const m = ev.metrics;
      const payload: Record<string, unknown> = { type: 'metrics' };
      if (m.type === 'stt_metrics') payload.sttDuration = m.durationMs;
      else if (m.type === 'llm_metrics') payload.llmDuration = m.durationMs;
      else if (m.type === 'tts_metrics') payload.ttsDuration = m.durationMs;
      const data = new TextEncoder().encode(JSON.stringify(payload));
      ctx.room.localParticipant?.publishData(data, { reliable: true });
    });

    await session.start({ agent, room: ctx.room });
    await ctx.waitForParticipant();

    session.generateReply({
      instructions: 'Greet the user briefly and ask how you can help.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
