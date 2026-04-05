# Realtime Voice API — Design Spec

Alternativa k OpenAI Realtime API postavená nad LiveKit (open-source). Plugovatelný voice pipeline s důrazem na minimální latenci.

## Cíle

- **Hlasový asistent** — mluvím, rychle dostanu mluvenou odpověď
- **Minimální latence** — streaming mezi všemi kroky pipeline
- **Plugovatelné komponenty** — STT, LLM, TTS, VAD vyměnitelné bez změny architektury
- **Čeština + angličtina**
- **Připraveno na OpenClaw** — architektura umožní napojení tool callingu ve fázi 2

## Architektura

```
Browser (WebRTC) ──► LiveKit Server (SFU) ──► Agent Worker (Node.js)
                 ◄──                       ◄──
```

### Komponenty

- **LiveKit Server** — self-hosted WebRTC SFU (Apache 2.0). Řeší STUN/TURN, codec negotiation, media transport. Běží v Docker containeru.
- **Agent Worker** — Node.js/TypeScript proces využívající `@livekit/agents` SDK. Připojí se k LiveKit jako participant a zpracovává audio pipeline.
- **Web klient** — vanilla HTML/JS stránka s `livekit-client` SDK.

### Voice Pipeline (uvnitř Agent Worker)

```
Audio In → Silero VAD → STT (Deepgram) → LLM (OpenAI/Google/xAI) → TTS (Deepgram) → Audio Out
```

Vše streamované — žádný krok nečeká na kompletní výstup předchozího:
- STT posílá partial results
- LLM tokeny tečou přímo do TTS
- TTS audio chunky tečou přímo do WebRTC
- Barge-in: když uživatel začne mluvit během odpovědi, agent okamžitě přeruší TTS

## Plugin systém

Využíváme LiveKit Agents SDK plugin interfaces. Dostupné pluginy z NPM:

| Komponenta | Výchozí (fáze 1) | Další dostupné |
|------------|-------------------|-----------------|
| VAD | `@livekit/agents-plugin-silero` | — |
| STT | `@livekit/agents-plugin-deepgram` | openai (Whisper), google |
| LLM | `@livekit/agents-plugin-openai` (GPT-4o-mini) | google (Gemini), xai (Grok) |
| TTS | `@livekit/agents-plugin-deepgram` | elevenlabs, cartesia, openai |

Výměna komponenty = změna jednoho řádku v konfiguraci:

```typescript
const session = new voice.AgentSession({
  vad: new silero.VAD(),
  stt: new deepgram.STT({ language: "cs" }),
  llm: new openai.LLM({ model: "gpt-4o-mini" }),
  tts: new deepgram.TTS({ voice: "aura-asteria-en" }),
});
```

## Web klient

Minimální vanilla HTML/JS stránka:

- **Velký mikrofon** uprostřed — vizuální indikátor stavu (listening/processing/speaking)
- **Connect / Disconnect** tlačítka
- **Scrollovatelná chat historie** — bubliny uživatel (vlevo, modré) / asistent (vpravo, šedé)
- **Live STT** — poslední bublina uživatele se plní v reálném čase (partial results)
- **Latence u odpovědí** — každá odpověď asistenta ukazuje celkovou latenci
- **Latence breakdown** — STT / LLM / TTS ms viditelné v debug panelu dole
- **Token endpoint** — agent server vystaví LiveKit JWT pro klienta

Technologie: vanilla HTML/CSS/JS + `livekit-client` SDK. Žádný framework.

## Infrastruktura

### Docker Compose

- `livekit-server` — oficiální LiveKit Docker image
- Agent worker běží na hostu (Node.js) pro snadný development

### Env proměnné

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `DEEPGRAM_API_KEY`
- `OPENAI_API_KEY` (nebo jiný LLM provider)

### Projektová struktura

```
realtimeApi/
├── docker-compose.yml        # LiveKit server
├── package.json
├── tsconfig.json
├── src/
│   ├── agent.ts              # Voice pipeline agent
│   ├── server.ts             # Token endpoint + static file serving
│   └── plugins/              # Budoucí custom pluginy (fáze 2)
├── web/
│   └── index.html            # Web klient
├── .env                      # API klíče
└── docs/
```

## Fáze

### Fáze 1 (teď)

1. LiveKit server setup (Docker)
2. Agent worker s voice pipeline (hotové LiveKit pluginy)
3. Web klient s chat historií
4. Měření latence (STT/LLM/TTS breakdown)

### Fáze 2 (později)

1. Anthropic/Claude LLM plugin pro LiveKit Agents (Node.js)
2. OpenClaw integrace (tool calling)
3. Další STT/TTS pluginy dle potřeby
4. Konverzační paměť
5. Produkční deploy

## Náklady

Žádné licenční poplatky. Platíme pouze:
- **Deepgram** — STT/TTS per minute/character
- **LLM provider** — per token
- **Infra** — server kde běží LiveKit + agent
