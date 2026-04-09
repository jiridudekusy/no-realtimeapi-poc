# Mobile Voice UI — Design Spec

## Goal

Standalone mobile-optimized page (`/mobile.html`) for voice-first interaction on iPhone — designed for use in a car with minimal visual attention.

## Layout

Vertical stack, top to bottom:

### 1. Project indicator (header)
- Small text at top: `📁 Project Name`
- Tappable — opens project selector (modal/dropdown with list of projects)
- Shows `🏠 Home` for `_global`

### 2. Transcript line
- Single line of running text with colored status label above
- States:
  - **DISCONNECTED** (gray) — "Tap Connect to start"
  - **LISTENING** (blue, `#7c83ff`) — live transcription of user speech
  - **THINKING** (yellow, `#f59e0b`) — agent processing / tool call, pulsing dots
  - **SPEAKING** (green, `#22c55e`) — agent response streaming as text
- Text wraps if needed but stays compact (max ~3 lines)
- Centered, large font (18px) for readability at arm's length

### 3. Buttons (vertical stack)
Three full-width buttons with large touch targets (padding 16-18px, border-radius 14px):

1. **Mute / Unmute** — toggles microphone
   - Default: `🎙️ Mute` (dark background)
   - Active: `🔇 Muted` (red tint)
2. **LLM: Auto / Hold** — toggles LLM hold mode
   - Default: `🧠 LLM: Auto` (dark background)
   - Active: `🧠 LLM: Hold` (amber tint)
3. **Connect / Disconnect**
   - Disconnected: `Connect` (green background)
   - Connected: `Disconnect` (red background)

### 4. Metrics line
- Small text below buttons (font-size 12px, gray)
- Shows: `LLM 2.1s` (just LLM latency, nothing else)
- Hidden when disconnected

## Functionality

### Voice connection
- Same LiveKit WebRTC as main UI — same `/api/token` endpoint
- Room naming: `voice-{timestamp}` (same as main UI)
- Thinking sound (Ocean Sweep) plays during THINKING state

### Project selector
- Tap project name → modal overlay with list of projects
- Fetches from `GET /api/projects`
- Selecting a project sends `session_init` via DataReceived (same mechanism as main UI)
- Auto-disconnect voice when switching projects (same as main UI)

### Session handling
- On connect, uses `_global` as default project (or last used, stored in localStorage)
- No session sidebar, no text input, no session history
- Sessions are created/resumed same as main UI via LiveKit data channel

### Data events
- Listens to same DataReceived events as main UI: `thinking`, `metrics`, `session_info`, `context_switched`, etc.
- TranscriptionReceived for live speech transcription

## Technical

### File
- `web/mobile.html` — single self-contained HTML file (inline CSS + JS)
- Imports `livekit-client` from CDN (same as main UI)
- No build step, no framework

### PWA meta tags
```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
```

### Desktop link
- Small `📱` icon button in main UI header (next to theme toggle)
- Links to `/mobile.html`

## What it does NOT have
- No text input
- No session sidebar / history
- No file browser
- No server events log
- No per-message bubbles (just one running line)
- No session name editing
- No cost display (just LLM latency)

## Colors (dark theme only)
- Background: `#111` (page), `#1a1a2e` (transcript area)
- Buttons: `#2a2a4a` (default), `#22c55e` (connect), `#ef4444` (disconnect/muted)
- Text: `#ccc` (primary), `#999` (secondary), `#666` (metrics)
- Status labels: `#7c83ff` (listening), `#f59e0b` (thinking), `#22c55e` (speaking)
