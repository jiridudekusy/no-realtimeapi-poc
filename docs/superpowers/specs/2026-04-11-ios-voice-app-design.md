# iOS Voice Assistant App — Design Spec

**Date:** 2026-04-11
**Status:** Approved
**Motivation:** AirPods stem mute/unmute gesture only works in native iOS apps. Web browsers (Safari) cannot receive AirPods hardware mute events — confirmed by testing and industry-wide limitation (Google Meet, Zoom, Discord all have the same issue in browser).

## Scope

Minimal native iOS app equivalent to `web/mobile.html`. Single-screen SwiftUI voice client that connects to the existing LiveKit + token server infrastructure. Primary value: AirPods Pro squeeze / AirPods Max Digital Crown → mute/unmute.

## What the app does

- Connect/disconnect to LiveKit room via existing token server
- Voice: publish microphone, subscribe to agent audio
- Mute/unmute via UI button AND AirPods hardware gesture
- LLM Hold/Auto toggle
- Project selector (list projects, switch, send session_init)
- Display transcript (last user/agent utterance)
- Display metrics (LLM latency)
- Thinking feedback: pulsing dots + "Ocean Sweep" audio (bandpass-filtered noise, same as web)
- Light + dark mode (follows system setting)

## What the app does NOT do

- No text chat input
- No session history / sidebar
- No file browser
- No offline support
- No CarPlay (requires paid developer account + entitlement)
- No push notifications

## Architecture

```
VoiceApp.swift          — App entry, AVAudioSession config
ContentView.swift       — Main UI screen
LiveKitService.swift    — ObservableObject: Room, connection, mute, transcript, metrics
ProjectService.swift    — HTTP: list/get projects, selected project state
ThinkingSound.swift     — AVAudioEngine "Ocean Sweep" generator
Config.swift            — Hardcoded server URL
```

### LiveKitService

ObservableObject holding all connection state:

- `@Published var connectionState: ConnectionState` (disconnected, connecting, connected)
- `@Published var isMuted: Bool`
- `@Published var isHeld: Bool`
- `@Published var statusText: String` (listening, thinking, speaking)
- `@Published var transcriptText: String`
- `@Published var llmLatency: Double?`
- `var sessionId: String?`
- `var pendingResume: String?`
- `var pendingProject: String?`

Methods:
- `connect(project:)` — fetch token, connect to room, enable mic, send session_init
- `disconnect()`
- `toggleMute()` — `localParticipant.setMicrophoneEnabled()`, sync with AVAudioSession
- `toggleHold()` — publish data message

Room delegate events:
- `TrackSubscribed` — attach agent audio
- `TranscriptionReceived` — update transcriptText, detect user vs agent
- `DataReceived` — parse JSON: thinking, tool_call, metrics, session_info, context_switched

### ProjectService

- `@Published var projects: [Project]`
- `@Published var currentProject: Project` (default: _global/Home)
- `func loadProjects()` — GET /api/projects
- `func selectProject(_:)` — update current, trigger reconnect

### ThinkingSound

Port of web "Ocean Sweep" sound:
- AVAudioEngine with noise buffer → bandpass filter (200→1200 Hz sweep) → gain envelope
- `start()` / `stop()` methods
- 2.5s pulse, repeated every 3.5s (same timing as web)

### AirPods Mute

- AVAudioSession configured with `.playAndRecord` category, `.voiceChat` mode
- LiveKit Swift SDK manages audio session automatically for WebRTC
- Native app with active audio session → AirPods stem gesture routes mute/unmute via OS
- Observe `AVAudioSession.muteStateChangeNotification` to sync UI (isMuted) when user mutes via AirPods

### Token Server Communication

Existing endpoints, no server changes needed:
- `GET {serverURL}/api/token?room=voice-{timestamp}&identity=user-ios` → `{ token }`
- `GET {serverURL}/api/projects` → `[{ name, displayName, description }]`
- `GET {serverURL}/api/projects/{name}` → `{ name, displayName, description }`

### LiveKit Data Protocol

Same JSON messages over `publishData` / `DataReceived` as web client:

Outgoing:
- `{ type: "session_init", sessionId?, projectName }` — on connect
- `{ type: "hold_llm" }` / `{ type: "release_llm" }` — hold toggle

Incoming:
- `{ type: "thinking" }` — start thinking dots + sound
- `{ type: "tool_call" }` — continue thinking, sound with 0.5s delay
- `{ type: "metrics", llmDuration }` — display latency
- `{ type: "session_info", sessionId, projectName }` — capture session, send session_init
- `{ type: "context_switched", projectName, sessionId }` — update project state

## UI

Single screen, dark theme matching mobile.html, adaptive for light mode.

```
┌─────────────────────────────┐
│  📁 Home ▾                  │  Project bar (tap → .sheet)
├─────────────────────────────┤
│        LISTENING            │  Status label (colored)
│   "transcript text..."     │  Last transcript
├─────────────────────────────┤
│  🎙️ Mute                   │  Mute button
│  🧠 LLM: Auto              │  Hold button
│  ██ Connect ██              │  Connect/Disconnect
├─────────────────────────────┤
│  LLM 1.2s                  │  Metrics
└─────────────────────────────┘
```

### Colors (adaptive)

| Element | Dark | Light |
|---------|------|-------|
| Background | #111111 | Color(.systemBackground) |
| Transcript area | #1a1a2e | Color(.secondarySystemBackground) |
| Buttons | #2a2a4a | Color(.tertiarySystemFill) |
| Muted button | #4a2020 / red text | Color.red.opacity(0.15) / red text |
| Held button | #4a3a10 / amber text | Color.orange.opacity(0.15) / orange text |
| Connect | green bg / white text | green bg / white text |
| Disconnect | red bg / white text | red bg / white text |
| Status colors | listening: #7c83ff, thinking: #f59e0b, speaking: #22c55e | same |

### Thinking Animation

Pulsing dots (3 circles, staggered animation) — same visual as web CSS `@keyframes tdot`.

### Project Sheet

Native `.sheet` with list of projects. Tap to select → disconnect + reconnect with new project.

## Dependencies

- `livekit-client-sdk-swift` via SPM (only dependency)
- Minimum iOS 17.0 (for AVAudioSession.muteStateChangeNotification)

## Deployment

- Sideload via Xcode (no Apple Developer account)
- 7-day re-sign cycle
- No App Store, no TestFlight

## Server URL

Hardcoded in `Config.swift`. User edits source to change. Default: Tailscale HTTPS URL.
