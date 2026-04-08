# Projects UI — Design Spec

## Goal

Add visual layer for project workspaces. Sidebar shows project tree with chats, file browser tab for project contents, breadcrumb navigation, file upload, project/session deletion. All building on the Spec 1 backend (projects, navigation, context switching).

This is Spec 2 of 2.

## Sidebar: Tree Structure

The sidebar changes from a flat chat list to a tree with collapsible project groups.

### Layout

```
Sessions          [Chats] [Files]
─────────────────────────
🔍 Search...
+ New Session    + New Project

▼ 🏠 Home
    General chat · 1h ago
    
▼ 📁 website-redesign        ✕
    ● Homepage layout · 2h ago
    Color palette · Yesterday
    Typography · 3d ago

▶ 📁 mobile-app (4)          ✕
▶ 📁 data-pipeline (2)       ✕
```

- Projects are collapsible groups (▼/▶)
- Active chat highlighted in blue
- Active project expanded by default
- Collapsed projects show chat count in parentheses
- `🏠 Home` = `_global` project, always at top
- `✕` button on project header for deletion
- Each chat has a delete button on hover

### Resizable Sidebar

- Drag handle on the right edge of the sidebar
- Min width: 200px, no max — constrained only by chat pane min width (300px)
- Cursor changes to `col-resize` on hover
- Width persisted in localStorage

### Buttons

- `+ New Session` — creates new chat in current project
- `+ New Project` — opens inline input for project name + optional description

### Context Menu on Project

Clicking `✕` on a project opens a deletion confirmation modal:
- "Delete project [name]? Type the project name to confirm:"
- Text input that must match project name exactly
- Delete button disabled until name matches
- Deletes the project directory and all its sessions

### Context Menu on Chat

Clicking delete (🗑 on hover) on a chat opens a simple confirmation:
- "Delete this chat? This cannot be undone."
- Yes / No buttons

## Sidebar: Files Tab

Second tab in sidebar header. Shows file tree of the current project directory.

### Layout

```
Sessions          [Chats] [Files]
─────────────────────────
📁 website-redesign/
  📁 docs/
    📄 requirements.md
    📄 brand-guide.pdf
  📁 output/
    📄 homepage-v2.html
    📄 color-palette.json
  📄 CLAUDE.md
  📄 .mcp.json

  [📎 Upload file]
```

- Tree structure matching actual filesystem
- Directories collapsible
- Files clickable
- Upload button at bottom (file input, sends to API)
- When in `_global` (Home), shows `_global/` contents
- Tab only visible when in a project (not when no project selected)

### File Click Behavior

- **Text files** (.md, .txt, .json, .ts, .js, .css, .html, .yaml, .yml, .csv, .xml, .env, .log): Open inline in main area
  - Code/text viewer with syntax highlighting (basic `<pre>` with monospace font)
  - "← Back to chat" button at top
  - File path shown as header
- **Binary files** (.pdf, .png, .jpg, .gif, .zip, .tar, etc.): Open in new browser tab (direct file URL)

### File Upload

- Button at bottom of Files tab
- Standard file input (`<input type="file">`)
- Uploads to `POST /api/projects/:name/files` 
- Uploaded to project root by default
- Shows upload progress (optional, v1 can skip)
- Refreshes file tree after upload

## Breadcrumb Navigation

Replaces the current session bar. Shows current location as a path.

### Format

```
📁 website-redesign / Homepage layout discussion  ✨  8. 4. 2026 · 12 zpráv
```

- Project name (📁 prefix, amber color) — clickable, calls `switch_project` info
- `/` separator
- Chat name (bold, editable on click) 
- ✨ generate name button
- Date + message count (grey, right-aligned or after name)

### When in Home

```
🏠 Home / General chat  ✨  8. 4. 2026 · 5 zpráv
```

### When no chat active (browsing file)

```
📁 website-redesign / 📄 requirements.md          ← Back to chat
```

## Main Area: File Viewer

When a text file is clicked in the Files tab:

- Conversation area replaced with file content
- Header: file path + "← Back to chat" button
- Content: `<pre>` block with monospace font, scrollable
- No editing (read-only for now)
- Back button returns to the conversation

## Backend API Additions

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects/:name/files` | GET | List files in project directory (recursive tree) |
| `/api/projects/:name/files/*` | GET | Get file content (text) or serve binary |
| `/api/projects/:name/files` | POST | Upload file (multipart/form-data) |
| `/api/projects/:name` | DELETE | Delete project (requires name confirmation in body) |
| `/api/projects/:name/sessions/:id` | DELETE | Delete session |

### File listing format

`GET /api/projects/:name/files` returns:

```json
[
  { "name": "docs", "type": "directory", "children": [
    { "name": "requirements.md", "type": "file", "size": 1234 },
    { "name": "brand-guide.pdf", "type": "file", "size": 56789 }
  ]},
  { "name": "CLAUDE.md", "type": "file", "size": 456 }
]
```

Sessions directory is excluded from the file listing.

### File serving

`GET /api/projects/:name/files/docs/requirements.md` returns the file content with appropriate Content-Type header.

### Project deletion

`DELETE /api/projects/:name` with body `{ "confirmName": "website-redesign" }`:
- Validates confirmName matches project name
- Removes project directory recursively
- Removes from projects.json index
- Returns 200 on success

### Session deletion

`DELETE /api/projects/:name/sessions/:id`:
- Removes session JSON file
- Removes from sessions index.json
- Returns 200 on success

## Error Handling

All user-facing operations must show visible error feedback:

- **API errors** (file upload, project/session delete, file listing): show error message in a toast/banner or inline near the action
- **Project deletion failed**: show error in the modal, don't close it
- **Session deletion failed**: show error near the chat item
- **File upload failed**: show error below the upload button
- **File listing failed**: show "Failed to load files" in the Files tab
- **Network errors**: catch fetch failures, show user-friendly message
- **No silent failures** — every error the user triggers must be visibly reported

## Out of Scope

- File editing via GUI (future)
- .mcp.json / CLAUDE.md editing via GUI (future)
- Drag & drop file upload
- File rename/move/delete
- Project rename
