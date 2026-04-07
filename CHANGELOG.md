# Release Notes

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
