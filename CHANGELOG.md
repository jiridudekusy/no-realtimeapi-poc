# Release Notes

## v1.2.0 (2026-04-08)

### Projects

You can now organize conversations into project workspaces. Each project is a self-contained directory with its own chat history, files, MCP servers (``.mcp.json``), Claude instructions (``CLAUDE.md``), and skills.

Navigation is fully voice-driven — say "switch to project X", "list my chats", "go back" — all while the voice connection stays active. No need to touch a screen.

### Project UI

The sidebar now shows a tree structure with collapsible project groups. Two tabs — **Chats** for conversation tree and **Files** for browsing project files. You can upload files, view text files inline, and open binary files in a new tab.

Projects can be created via the **+ New Project** button (modal dialog) or by voice. Deletion requires typing the project name to confirm.

### Breadcrumb Navigation

The session bar now shows a breadcrumb path: ``📁 project / chat name``. The project name is clickable.

### File Browser

Browse project files in the sidebar **Files** tab. Text files (`.md`, `.json`, `.ts`, etc.) open inline in the main area with a read-only viewer. Binary files open in a new browser tab. Upload files via the upload button.

### Resizable Sidebar

Drag the right edge of the sidebar to resize. Width is persisted in localStorage. The chat pane has a minimum width of 300px.

### Multi-Architecture Docker Build

Docker images now build for both ``linux/amd64`` and ``linux/arm64`` (Apple Silicon, Raspberry Pi, etc.).

### Upgrade Notes

**Docker volume change.** The `session-data` volume is replaced by `workspace`:

```yaml
# In your docker-compose services.agent.volumes:
- workspace:/app/workspace

# In top-level volumes:
volumes:
  claude-auth:
  workspace:
```

Existing sessions from v1.1.0 are automatically migrated into `workspace/_global/sessions/` on first start.

**New dependency.** `multer` is added for file uploads — requires `docker compose build agent`.

---

## v1.1.0 (2026-04-08)

### Text Input

You can now type messages directly — no voice connection needed. Just open the app and start typing. The assistant responds in text only (no speech). You can freely switch between typing and talking within the same conversation — context is fully preserved.

### Session History

All conversations are now saved and browsable in a sidebar. You can search across all past sessions (fulltext), view transcripts read-only, and resume any previous conversation with full context — both via text (just type) and voice (click Resume + Connect).

### Session Naming

Sessions can be renamed by clicking the name in the header. There's also a ✨ button that auto-generates a short title from the conversation content.

### Smarter Voice Input

Speech is now coalesced with a 2-second debounce — if you pause briefly (e.g., to breathe or think), it won't split your message. Everything you say before a 2-second silence is sent as one message to Claude.

### Redesigned UI

- Chat area now fills the full viewport — no more wasted vertical space
- Controls (mic, connect, latency, cost) merged into one compact toolbar
- Server Events log collapsed by default
- Session info bar with name, date, and message count

### Latency Display

- STT and LLM latency now show real values (previously STT was always 0ms, LLM was missing)
- Metrics displayed in the toolbar only

### Upgrade Notes

**New Docker volume required.** Add `session-data` volume to your deployment:

```yaml
# In your docker-compose services.agent.volumes:
- session-data:/app/data/sessions

# In top-level volumes:
volumes:
  claude-auth:
  session-data:
```

If using the pre-built image, pull the latest and update your `docker-compose.prod.yml` accordingly. Existing conversations from v1.0.0 are not migrated (there was no persistence before).
