# Projects UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visual project UI — tree sidebar with collapsible projects, file browser tab, breadcrumb navigation, file viewer, upload, project/session deletion with confirmations.

**Architecture:** Backend adds file listing/serving/upload/delete endpoints to token-server. Frontend refactors sidebar from flat list to tree with Chats/Files tabs, adds resizable drag handle, modal confirmations, file viewer in main area, and breadcrumb session bar.

**Tech Stack:** TypeScript (ESM), Express v5 (multer for upload), vanilla HTML/CSS/JS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/token-server.ts` | Modify | Add file API endpoints (list, serve, upload), project delete, session delete |
| `src/project-store.ts` | Modify | Add deleteProject method |
| `src/session-store.ts` | Modify | Add deleteSession method |
| `web/index.html` | Modify | Tree sidebar HTML, tabs, breadcrumb, file viewer, modals, resize handle |
| `web/style.css` | Modify | Tree styles, tabs, resize handle, modals, file viewer, breadcrumb |
| `web/app.js` | Modify | Tree rendering, tab switching, file browser, upload, deletion, resize, breadcrumb |

---

### Task 1: Backend — Session and Project Deletion

**Files:**
- Modify: `src/session-store.ts`
- Modify: `src/project-store.ts`
- Modify: `src/token-server.ts`

- [ ] **Step 1: Add deleteSession to SessionStore**

In `src/session-store.ts`, add after the `setName` method:

```typescript
  async deleteSession(sessionId: string): Promise<void> {
    const filePath = path.join(this.#dir, `${sessionId}.json`);
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(filePath);
    } catch {}
    // Remove from index
    const index = await this.#readIndex();
    const filtered = index.filter(e => e.sessionId !== sessionId);
    await this.#writeIndex(filtered);
  }
```

- [ ] **Step 2: Add deleteProject to ProjectStore**

In `src/project-store.ts`, add after the `updateProject` method:

```typescript
  async deleteProject(name: string): Promise<void> {
    if (name === '_global') throw new Error('Cannot delete _global');
    const projects = await this.listProjects();
    const idx = projects.findIndex(p => p.name === name);
    if (idx === -1) throw new Error(`Project "${name}" not found`);

    // Remove directory
    const projectDir = this.getProjectDir(name);
    const { rm } = await import('node:fs/promises');
    await rm(projectDir, { recursive: true, force: true });

    // Remove from index
    projects.splice(idx, 1);
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');
  }
```

- [ ] **Step 3: Add DELETE endpoints to token-server**

In `src/token-server.ts`, add after the existing `PATCH /api/projects/:name` endpoint:

```typescript
app.delete('/api/projects/:name', async (req, res) => {
  try {
    const { confirmName } = req.body;
    if (confirmName !== req.params.name) {
      res.status(400).json({ error: 'Project name confirmation does not match' });
      return;
    }
    await projectStore.deleteProject(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
```

Add after the existing session generate-name endpoint:

```typescript
app.delete('/api/projects/:name/sessions/:id', async (req, res) => {
  try {
    const store = getSessionStore(req.params.name);
    await store.init();
    await store.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts src/project-store.ts src/token-server.ts
git commit -m "feat: project and session deletion endpoints"
```

---

### Task 2: Backend — File API (List, Serve, Upload)

**Files:**
- Modify: `src/token-server.ts`

- [ ] **Step 1: Install multer for file uploads**

```bash
npm install multer @types/multer
```

- [ ] **Step 2: Add file listing endpoint**

In `src/token-server.ts`, add imports at the top:

```typescript
import { readdir, stat } from 'node:fs/promises';
import multer from 'multer';
```

Add the file listing endpoint:

```typescript
interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileEntry[];
}

async function listFilesRecursive(dir: string, exclude: string[] = ['sessions']): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (exclude.includes(item.name)) continue;
      if (item.name.startsWith('.claude')) continue; // skip .claude directory
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        const children = await listFilesRecursive(fullPath, []);
        entries.push({ name: item.name, type: 'directory', children });
      } else {
        const stats = await stat(fullPath);
        entries.push({ name: item.name, type: 'file', size: stats.size });
      }
    }
  } catch {}
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

app.get('/api/projects/:name/files', async (req, res) => {
  try {
    const projectDir = projectStore.getProjectDir(req.params.name);
    const files = await listFilesRecursive(projectDir);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});
```

- [ ] **Step 3: Add file serving endpoint**

```typescript
app.get('/api/projects/:name/files/*', async (req, res) => {
  try {
    const projectDir = projectStore.getProjectDir(req.params.name);
    // req.params[0] contains the wildcard path
    const filePath = path.join(projectDir, req.params[0]);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    const projectResolved = path.resolve(projectDir);
    if (!resolved.startsWith(projectResolved)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Check if file exists
    const { existsSync } = await import('node:fs');
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Serve the file with appropriate content type
    res.sendFile(resolved);
  } catch (err) {
    res.status(500).json({ error: 'Failed to serve file' });
  }
});
```

- [ ] **Step 4: Add file upload endpoint**

```typescript
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const projectDir = projectStore.getProjectDir(req.params.name);
      cb(null, projectDir);
    },
    filename: (_req, file, cb) => {
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

app.post('/api/projects/:name/files', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }
  res.json({ ok: true, filename: req.file.originalname, size: req.file.size });
});
```

- [ ] **Step 5: Verify compilation and install**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/token-server.ts package.json package-lock.json
git commit -m "feat: file API — list, serve, upload endpoints"
```

---

### Task 3: Frontend — Sidebar HTML Restructure + Tabs

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Replace sidebar HTML**

Replace the entire `<aside id="sidebar">` block with:

```html
    <aside id="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Sessions</span>
        <div class="sidebar-tabs">
          <button class="sidebar-tab active" data-tab="chats">Chats</button>
          <button class="sidebar-tab" data-tab="files">Files</button>
        </div>
        <button id="sidebar-close" class="sidebar-close">✕</button>
      </div>

      <!-- Chats tab -->
      <div id="tab-chats" class="sidebar-tab-content active">
        <input id="session-search" type="text" placeholder="Search sessions..." class="session-search" />
        <div class="sidebar-actions">
          <button id="new-session-btn" class="new-session-btn">+ New Chat</button>
          <button id="new-project-btn" class="new-project-btn">+ New Project</button>
        </div>
        <div id="new-project-form" class="new-project-form" style="display:none;">
          <input id="new-project-name" type="text" placeholder="Project name..." class="session-search" />
          <input id="new-project-desc" type="text" placeholder="Description (optional)..." class="session-search" />
          <div class="new-project-form-actions">
            <button id="new-project-submit" class="new-session-btn">Create</button>
            <button id="new-project-cancel" class="new-project-cancel">Cancel</button>
          </div>
        </div>
        <div id="project-tree" class="project-tree"></div>
      </div>

      <!-- Files tab -->
      <div id="tab-files" class="sidebar-tab-content">
        <div id="file-tree" class="file-tree"></div>
        <div id="file-upload-area" class="file-upload-area">
          <label class="file-upload-btn">
            📎 Upload file
            <input id="file-upload-input" type="file" style="display:none" />
          </label>
          <div id="file-upload-error" class="file-upload-error"></div>
        </div>
      </div>

      <div id="sidebar-resize" class="sidebar-resize"></div>
    </aside>
```

- [ ] **Step 2: Replace session-bar with breadcrumb**

Replace the `session-bar` div:

```html
      <div id="session-bar" class="session-bar" style="display: none;">
        <div class="session-bar-left">
          <span id="breadcrumb-project" class="breadcrumb-project"></span>
          <span class="breadcrumb-sep">/</span>
          <span id="session-name" class="session-name" contenteditable="true" spellcheck="false"></span>
          <button id="generate-name-btn" class="generate-name-btn" title="Generate name from conversation">✨</button>
          <span id="session-meta" class="session-bar-meta"></span>
        </div>
        <button id="resume-btn" class="resume-btn" style="display: none;">▶ Resume</button>
      </div>
```

- [ ] **Step 3: Add file viewer and modals**

Before `</div> <!-- #app -->`, add:

```html
      <!-- File viewer (hidden by default) -->
      <div id="file-viewer" style="display:none;">
        <div class="file-viewer-header">
          <span id="file-viewer-path"></span>
          <button id="file-viewer-back" class="file-viewer-back">← Back to chat</button>
        </div>
        <pre id="file-viewer-content" class="file-viewer-content"></pre>
      </div>

      <!-- Delete project modal -->
      <div id="modal-delete-project" class="modal" style="display:none;">
        <div class="modal-content">
          <h3>Delete project</h3>
          <p>Type <strong id="modal-project-name"></strong> to confirm:</p>
          <input id="modal-project-input" type="text" class="session-search" />
          <div id="modal-project-error" class="modal-error"></div>
          <div class="modal-actions">
            <button id="modal-project-delete" class="modal-btn-danger" disabled>Delete</button>
            <button id="modal-project-cancel" class="modal-btn">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Delete session modal -->
      <div id="modal-delete-session" class="modal" style="display:none;">
        <div class="modal-content">
          <h3>Delete this chat?</h3>
          <p>This cannot be undone.</p>
          <div id="modal-session-error" class="modal-error"></div>
          <div class="modal-actions">
            <button id="modal-session-delete" class="modal-btn-danger">Yes, delete</button>
            <button id="modal-session-cancel" class="modal-btn">No</button>
          </div>
        </div>
      </div>
```

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat: sidebar tree HTML, tabs, breadcrumb, file viewer, modals"
```

---

### Task 4: Frontend — CSS for Tree, Tabs, Resize, Modals, File Viewer, Breadcrumb

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Add sidebar tabs CSS**

After existing sidebar styles:

```css
/* --- Sidebar Tabs --- */
.sidebar-tabs {
  display: flex;
  gap: 0;
}

.sidebar-tab {
  background: none;
  border: none;
  color: #666;
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.sidebar-tab.active { color: #93c5fd; border-bottom-color: #2563eb; }
.sidebar-tab:hover { color: #ccc; }

.sidebar-tab-content { display: none; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
.sidebar-tab-content.active { display: flex; }

.sidebar-actions {
  display: flex;
  gap: 0.3rem;
  margin-bottom: 0.5rem;
}
.sidebar-actions .new-session-btn,
.sidebar-actions .new-project-btn {
  flex: 1;
  font-size: 0.75rem;
  padding: 0.35rem;
}

.new-project-btn {
  background: rgba(168,85,247,0.2);
  color: #c084fc;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.new-project-btn:hover { background: rgba(168,85,247,0.3); }

.new-project-form {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.5rem;
  padding: 0.5rem;
  border: 1px solid #333;
  border-radius: 6px;
}
.new-project-form-actions { display: flex; gap: 0.3rem; }
.new-project-cancel {
  flex: 1;
  background: rgba(255,255,255,0.1);
  color: #888;
  border: none;
  border-radius: 6px;
  padding: 0.35rem;
  cursor: pointer;
  font-size: 0.75rem;
}
```

- [ ] **Step 2: Add project tree CSS**

```css
/* --- Project Tree --- */
.project-tree { flex: 1; overflow-y: auto; }

.project-group { margin-bottom: 0.2rem; }

.project-header {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.4rem;
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.8rem;
  color: #999;
}
.project-header:hover { background: rgba(255,255,255,0.05); }
.project-header.active { color: #93c5fd; }

.project-toggle { font-size: 0.6rem; width: 1rem; text-align: center; flex-shrink: 0; }
.project-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-count { color: #555; font-size: 0.7rem; }
.project-delete {
  display: none;
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 0.7rem;
  padding: 0 0.2rem;
}
.project-header:hover .project-delete { display: block; }
.project-delete:hover { color: #ef4444; }

.project-chats {
  padding-left: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.project-chats.collapsed { display: none; }

.chat-item {
  display: flex;
  align-items: center;
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
  color: #888;
}
.chat-item:hover { background: rgba(255,255,255,0.05); }
.chat-item.active { background: rgba(37,99,235,0.15); color: #93c5fd; }

.chat-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item-meta { color: #555; font-size: 0.65rem; flex-shrink: 0; margin-left: 0.3rem; }
.chat-item-delete {
  display: none;
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 0.65rem;
  padding: 0 0.2rem;
}
.chat-item:hover .chat-item-delete { display: block; }
.chat-item-delete:hover { color: #ef4444; }
```

- [ ] **Step 3: Add resize handle CSS**

```css
/* --- Sidebar Resize --- */
.sidebar-resize {
  position: absolute;
  top: 0;
  right: 0;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}
.sidebar-resize:hover,
.sidebar-resize.dragging { background: #2563eb; }

#sidebar { position: relative; }
```

- [ ] **Step 4: Add breadcrumb CSS**

```css
/* --- Breadcrumb --- */
.breadcrumb-project {
  color: #f59e0b;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.breadcrumb-project:hover { text-decoration: underline; }
.breadcrumb-sep { color: #444; margin: 0 0.3rem; }
```

- [ ] **Step 5: Add file tree CSS**

```css
/* --- File Tree --- */
.file-tree { flex: 1; overflow-y: auto; padding: 0.3rem 0; font-size: 0.8rem; }

.file-tree-item {
  padding: 0.15rem 0.4rem;
  cursor: pointer;
  color: #999;
  border-radius: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-tree-item:hover { background: rgba(255,255,255,0.05); color: #ccc; }
.file-tree-dir { color: #f59e0b; font-weight: 600; }

.file-upload-area { padding: 0.5rem; }
.file-upload-btn {
  display: block;
  text-align: center;
  background: #2563eb;
  color: white;
  padding: 0.4rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
}
.file-upload-btn:hover { background: #1d4ed8; }
.file-upload-error { color: #ef4444; font-size: 0.75rem; margin-top: 0.3rem; }
```

- [ ] **Step 6: Add file viewer CSS**

```css
/* --- File Viewer --- */
.file-viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.3rem 0;
  font-size: 0.85rem;
  color: #888;
}
.file-viewer-back {
  background: none;
  border: 1px solid #333;
  color: #888;
  border-radius: 4px;
  padding: 0.2rem 0.6rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.file-viewer-back:hover { color: #ccc; border-color: #555; }
.file-viewer-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 1rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  color: #ccc;
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 7: Add modal CSS**

```css
/* --- Modals --- */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-content {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 1.5rem;
  max-width: 400px;
  width: 90%;
}
.modal-content h3 { margin-bottom: 0.5rem; font-size: 1rem; }
.modal-content p { font-size: 0.85rem; color: #999; margin-bottom: 0.75rem; }
.modal-error { color: #ef4444; font-size: 0.8rem; margin-bottom: 0.5rem; }
.modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.modal-btn {
  background: rgba(255,255,255,0.1);
  color: #ccc;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.modal-btn:hover { background: rgba(255,255,255,0.15); }
.modal-btn-danger {
  background: rgba(239,68,68,0.2);
  color: #f87171;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.modal-btn-danger:hover { background: rgba(239,68,68,0.3); }
.modal-btn-danger:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 8: Add light mode overrides**

In the `body.light` section:

```css
body.light .sidebar-tab { color: #999; }
body.light .sidebar-tab.active { color: #1d4ed8; }
body.light .project-header { color: #555; }
body.light .project-header.active { color: #1d4ed8; }
body.light .chat-item { color: #666; }
body.light .chat-item.active { color: #1d4ed8; background: rgba(37,99,235,0.08); }
body.light .file-tree-item:hover { background: rgba(0,0,0,0.05); color: #333; }
body.light .file-viewer-content { background: #f8f8f8; border-color: #e0e0e0; color: #333; }
body.light .modal-content { background: #fff; border-color: #e0e0e0; }
body.light .breadcrumb-sep { color: #ccc; }
```

Duplicate with `body:not(.dark)` prefix in the media query block.

- [ ] **Step 9: Add chat pane min-width**

```css
#app { min-width: 300px; }
```

- [ ] **Step 10: Commit**

```bash
git add web/style.css
git commit -m "feat: CSS for tree sidebar, tabs, resize, modals, file viewer, breadcrumb"
```

---

### Task 5: Frontend JS — Tree Sidebar Rendering

**Files:**
- Modify: `web/app.js`

This replaces the flat `renderSessionList()` + `fetchSessions()` with a tree that shows projects with their chats.

- [ ] **Step 1: Replace fetchSessions and renderSessionList**

Replace `fetchSessions` with `fetchProjectTree` that loads all projects + their chats:

```javascript
async function fetchProjectTree() {
  try {
    // Fetch projects
    const projectsRes = await fetch('/api/projects');
    const projects = projectsRes.ok ? await projectsRes.json() : [];

    // Fetch _global chats
    const globalRes = await fetch('/api/projects/_global/sessions');
    const globalChats = globalRes.ok ? await globalRes.json() : [];

    // Fetch chats for each project
    const projectData = await Promise.all(projects.map(async (p) => {
      const res = await fetch(`/api/projects/${p.name}/sessions`);
      const chats = res.ok ? await res.json() : [];
      return { ...p, chats };
    }));

    renderProjectTree(globalChats, projectData);
  } catch (err) {
    console.error('Failed to fetch project tree:', err);
  }
}
```

```javascript
function renderProjectTree(globalChats, projects) {
  const tree = $('#project-tree');
  tree.innerHTML = '';

  // Home (_global)
  tree.appendChild(createProjectGroup('_global', '🏠 Home', null, globalChats, false));

  // Projects
  for (const p of projects) {
    tree.appendChild(createProjectGroup(p.name, `📁 ${p.name}`, p.description, p.chats, true));
  }

  updateSessionBar();
}

function createProjectGroup(projectName, displayName, description, chats, canDelete) {
  const group = document.createElement('div');
  group.className = 'project-group';

  const isActive = sessionState.currentProject === projectName;
  const isExpanded = isActive || (chats.length > 0 && chats.length <= 3);

  // Header
  const header = document.createElement('div');
  header.className = `project-header${isActive ? ' active' : ''}`;
  header.innerHTML = `
    <span class="project-toggle">${isExpanded ? '▼' : '▶'}</span>
    <span class="project-name">${escapeHtml(displayName)}</span>
    ${!isExpanded && chats.length > 0 ? `<span class="project-count">(${chats.length})</span>` : ''}
    ${canDelete ? '<button class="project-delete" title="Delete project">✕</button>' : ''}
  `;

  header.addEventListener('click', (e) => {
    if (e.target.closest('.project-delete')) return;
    const chatsDiv = group.querySelector('.project-chats');
    const toggle = header.querySelector('.project-toggle');
    chatsDiv.classList.toggle('collapsed');
    toggle.textContent = chatsDiv.classList.contains('collapsed') ? '▶' : '▼';
  });

  if (canDelete) {
    header.querySelector('.project-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteProjectModal(projectName);
    });
  }

  group.appendChild(header);

  // Chats
  const chatsDiv = document.createElement('div');
  chatsDiv.className = `project-chats${isExpanded ? '' : ' collapsed'}`;

  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = `chat-item${chat.sessionId === sessionState.currentSessionId ? ' active' : ''}`;
    const age = getTimeAgo(chat.updated);
    item.innerHTML = `
      <span class="chat-item-text">${escapeHtml(chat.name || chat.preview)}</span>
      <span class="chat-item-meta">${age}</span>
      <button class="chat-item-delete" title="Delete chat">🗑</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.chat-item-delete')) return;
      onSessionClick(chat.sessionId, projectName);
    });

    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      showDeleteSessionModal(projectName, chat.sessionId, chat.name || chat.preview);
    });

    chatsDiv.appendChild(item);
  }

  group.appendChild(chatsDiv);
  return group;
}

function getTimeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
```

- [ ] **Step 2: Update onSessionClick to accept projectName**

```javascript
async function onSessionClick(sessionId, projectName) {
  if (sessionId === sessionState.currentSessionId && projectName === sessionState.currentProject && state.connected) {
    closeSidebar();
    return;
  }

  if (state.connected) {
    room.disconnect();
  }

  sessionState.currentProject = projectName || '_global';
  sessionState.currentSessionId = null;

  try {
    const res = await fetch(`/api/projects/${sessionState.currentProject}/sessions/${sessionId}`);
    if (!res.ok) return;
    const session = await res.json();
    showReadOnlyTranscript(session);
    sessionState.viewingSessionId = sessionId;
    fetchProjectTree();
    updateSessionBar();
    closeSidebar();
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}
```

- [ ] **Step 3: Replace all fetchSessions calls with fetchProjectTree**

Search and replace all `fetchSessions()` calls with `fetchProjectTree()`. Also replace all `renderSessionList()` calls with `fetchProjectTree()`.

- [ ] **Step 4: Update search to filter within tree**

```javascript
$('#session-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = e.target.value.trim();
    if (query) {
      // Search across all projects
      fetchProjectTreeFiltered(query);
    } else {
      fetchProjectTree();
    }
  }, 300);
});

async function fetchProjectTreeFiltered(query) {
  try {
    const projectsRes = await fetch('/api/projects');
    const projects = projectsRes.ok ? await projectsRes.json() : [];

    const globalRes = await fetch(`/api/projects/_global/sessions?q=${encodeURIComponent(query)}`);
    const globalChats = globalRes.ok ? await globalRes.json() : [];

    const projectData = await Promise.all(projects.map(async (p) => {
      const res = await fetch(`/api/projects/${p.name}/sessions?q=${encodeURIComponent(query)}`);
      const chats = res.ok ? await res.json() : [];
      return { ...p, chats };
    }));

    // Only show projects with matching chats
    const filtered = projectData.filter(p => p.chats.length > 0);
    renderProjectTree(globalChats, filtered);
  } catch (err) {
    console.error('Failed to search:', err);
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat: tree sidebar with collapsible projects and chats"
```

---

### Task 6: Frontend JS — Tabs, File Browser, Upload, File Viewer

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Add tab switching logic**

```javascript
// --- Sidebar Tabs ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'files') fetchFileTree();
  });
});
```

- [ ] **Step 2: Add file tree fetching and rendering**

```javascript
const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.ts', '.js', '.css', '.html', '.yaml', '.yml', '.csv', '.xml', '.env', '.log', '.mjs', '.jsx', '.tsx'];

async function fetchFileTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '<div style="color:#666;font-size:0.8rem;padding:0.5rem">Loading...</div>';
  try {
    const project = sessionState.currentProject || '_global';
    const res = await fetch(`/api/projects/${project}/files`);
    if (!res.ok) throw new Error('Failed to load files');
    const files = await res.json();
    tree.innerHTML = '';
    renderFileTree(tree, files, '');
  } catch (err) {
    tree.innerHTML = `<div style="color:#ef4444;font-size:0.8rem;padding:0.5rem">${err.message}</div>`;
  }
}

function renderFileTree(container, entries, pathPrefix) {
  for (const entry of entries) {
    const fullPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    item.style.paddingLeft = `${(fullPath.split('/').length - 1) * 0.8 + 0.4}rem`;

    if (entry.type === 'directory') {
      item.classList.add('file-tree-dir');
      item.textContent = `📁 ${entry.name}/`;
      let expanded = true;
      item.addEventListener('click', () => {
        expanded = !expanded;
        const children = item.nextElementSibling;
        if (children && children.classList.contains('file-tree-children')) {
          children.style.display = expanded ? '' : 'none';
        }
        item.textContent = `${expanded ? '📂' : '📁'} ${entry.name}/`;
      });
      container.appendChild(item);

      if (entry.children && entry.children.length > 0) {
        const childContainer = document.createElement('div');
        childContainer.className = 'file-tree-children';
        renderFileTree(childContainer, entry.children, fullPath);
        container.appendChild(childContainer);
      }
    } else {
      item.textContent = `📄 ${entry.name}`;
      if (entry.size != null) {
        const sizeStr = entry.size < 1024 ? `${entry.size}B` : `${Math.round(entry.size / 1024)}KB`;
        item.title = sizeStr;
      }
      item.addEventListener('click', () => openFile(fullPath, entry.name));
      container.appendChild(item);
    }
  }
}

function openFile(filePath, fileName) {
  const project = sessionState.currentProject || '_global';
  const ext = '.' + fileName.split('.').pop().toLowerCase();

  if (TEXT_EXTENSIONS.includes(ext)) {
    // Open inline
    showFileViewer(project, filePath);
  } else {
    // Open in new tab
    window.open(`/api/projects/${project}/files/${filePath}`, '_blank');
  }
}

async function showFileViewer(project, filePath) {
  try {
    const res = await fetch(`/api/projects/${project}/files/${filePath}`);
    if (!res.ok) throw new Error('Failed to load file');
    const content = await res.text();

    $('#conversation').style.display = 'none';
    $('#text-input-bar').style.display = 'none';
    $('#file-viewer').style.display = 'flex';
    $('#file-viewer').style.flexDirection = 'column';
    $('#file-viewer').style.flex = '1';
    $('#file-viewer').style.minHeight = '0';
    $('#file-viewer-path').textContent = `📄 ${filePath}`;
    $('#file-viewer-content').textContent = content;

    // Update breadcrumb
    updateSessionBar();
    sessionState.viewingFile = filePath;
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

$('#file-viewer-back').addEventListener('click', () => {
  $('#file-viewer').style.display = 'none';
  $('#conversation').style.display = '';
  $('#text-input-bar').style.display = '';
  sessionState.viewingFile = null;
  updateSessionBar();
});
```

- [ ] **Step 3: Add file upload logic**

```javascript
$('#file-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const project = sessionState.currentProject || '_global';
  const errorEl = $('#file-upload-error');
  errorEl.textContent = '';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`/api/projects/${project}/files`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Upload failed');
    }
    fetchFileTree();
  } catch (err) {
    errorEl.textContent = `Upload failed: ${err.message}`;
  }

  e.target.value = '';
});
```

- [ ] **Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat: file browser tab, file viewer, upload"
```

---

### Task 7: Frontend JS — New Project, Deletion Modals, Resize Handle

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Add new project form logic**

```javascript
$('#new-project-btn').addEventListener('click', () => {
  $('#new-project-form').style.display = '';
  $('#new-project-name').focus();
});

$('#new-project-cancel').addEventListener('click', () => {
  $('#new-project-form').style.display = 'none';
  $('#new-project-name').value = '';
  $('#new-project-desc').value = '';
});

$('#new-project-submit').addEventListener('click', async () => {
  const name = $('#new-project-name').value.trim();
  if (!name) return;
  const description = $('#new-project-desc').value.trim() || undefined;

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Error: ${data.error || 'Failed to create project'}`);
      return;
    }
    $('#new-project-form').style.display = 'none';
    $('#new-project-name').value = '';
    $('#new-project-desc').value = '';
    fetchProjectTree();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});
```

- [ ] **Step 2: Add delete project modal logic**

```javascript
let pendingDeleteProject = null;

function showDeleteProjectModal(projectName) {
  pendingDeleteProject = projectName;
  $('#modal-project-name').textContent = projectName;
  $('#modal-project-input').value = '';
  $('#modal-project-error').textContent = '';
  $('#modal-project-delete').disabled = true;
  $('#modal-delete-project').style.display = 'flex';
  $('#modal-project-input').focus();
}

$('#modal-project-input').addEventListener('input', (e) => {
  $('#modal-project-delete').disabled = e.target.value !== pendingDeleteProject;
});

$('#modal-project-delete').addEventListener('click', async () => {
  if (!pendingDeleteProject) return;
  const errorEl = $('#modal-project-error');
  errorEl.textContent = '';

  try {
    const res = await fetch(`/api/projects/${pendingDeleteProject}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmName: pendingDeleteProject }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
    $('#modal-delete-project').style.display = 'none';
    if (sessionState.currentProject === pendingDeleteProject) {
      sessionState.currentProject = '_global';
      sessionState.currentSessionId = null;
    }
    fetchProjectTree();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

$('#modal-project-cancel').addEventListener('click', () => {
  $('#modal-delete-project').style.display = 'none';
});
```

- [ ] **Step 3: Add delete session modal logic**

```javascript
let pendingDeleteSession = null;

function showDeleteSessionModal(projectName, sessionId, chatName) {
  pendingDeleteSession = { projectName, sessionId };
  $('#modal-session-error').textContent = '';
  $('#modal-delete-session').style.display = 'flex';
}

$('#modal-session-delete').addEventListener('click', async () => {
  if (!pendingDeleteSession) return;
  const { projectName, sessionId } = pendingDeleteSession;
  const errorEl = $('#modal-session-error');
  errorEl.textContent = '';

  try {
    const res = await fetch(`/api/projects/${projectName}/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
    $('#modal-delete-session').style.display = 'none';
    if (sessionState.currentSessionId === sessionId) {
      sessionState.currentSessionId = null;
      $('#conversation').innerHTML = '';
    }
    fetchProjectTree();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

$('#modal-session-cancel').addEventListener('click', () => {
  $('#modal-delete-session').style.display = 'none';
});
```

- [ ] **Step 4: Add resize handle logic**

```javascript
// --- Sidebar Resize ---
const resizeHandle = $('#sidebar-resize');
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const sidebar = $('#sidebar');
  const appMinWidth = 300;
  const maxWidth = window.innerWidth - appMinWidth;
  const newWidth = Math.max(200, Math.min(e.clientX, maxWidth));
  sidebar.style.width = `${newWidth}px`;
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  localStorage.setItem('sidebarWidth', $('#sidebar').style.width);
});

// Restore saved width
const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) $('#sidebar').style.width = savedWidth;
```

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat: new project form, deletion modals, sidebar resize"
```

---

### Task 8: Frontend JS — Breadcrumb Session Bar

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Update updateSessionBar to show breadcrumb**

Replace the existing `updateSessionBar` function:

```javascript
function updateSessionBar() {
  const bar = $('#session-bar');
  const projectEl = $('#breadcrumb-project');
  const nameEl = $('#session-name');
  const metaEl = $('#session-meta');
  const resumeBtn = $('#resume-btn');
  const targetId = sessionState.viewingSessionId || sessionState.currentSessionId;

  // Show breadcrumb for file viewer
  if (sessionState.viewingFile) {
    bar.style.display = 'flex';
    const project = sessionState.currentProject || '_global';
    projectEl.textContent = project === '_global' ? '🏠 Home' : `📁 ${project}`;
    nameEl.textContent = `📄 ${sessionState.viewingFile}`;
    nameEl.contentEditable = 'false';
    $('#generate-name-btn').style.display = 'none';
    metaEl.textContent = '';
    resumeBtn.style.display = 'none';
    return;
  }

  if (!targetId) {
    // Show just project if we have one
    if (sessionState.currentProject && sessionState.currentProject !== '_global') {
      bar.style.display = 'flex';
      projectEl.textContent = `📁 ${sessionState.currentProject}`;
      nameEl.textContent = '';
      metaEl.textContent = '';
      resumeBtn.style.display = 'none';
      $('#generate-name-btn').style.display = 'none';
      return;
    }
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  // Project part
  const project = sessionState.currentProject || '_global';
  projectEl.textContent = project === '_global' ? '🏠 Home' : `📁 ${project}`;

  // Find session in any loaded data
  const session = findSessionInTree(targetId);

  nameEl.textContent = session?.name || session?.preview || 'Untitled';
  nameEl.contentEditable = sessionState.viewingSessionId ? 'false' : 'true';
  $('#generate-name-btn').style.display = '';

  if (session) {
    const date = new Date(session.created);
    const dateStr = date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    metaEl.textContent = `${dateStr} ${timeStr} · ${session.messageCount} zpráv`;
  } else {
    metaEl.textContent = '';
  }

  resumeBtn.style.display = sessionState.viewingSessionId ? '' : 'none';
}

// Helper to find session in cached tree data
let cachedTreeData = { globalChats: [], projects: [] };

function findSessionInTree(sessionId) {
  for (const chat of cachedTreeData.globalChats) {
    if (chat.sessionId === sessionId) return chat;
  }
  for (const p of cachedTreeData.projects) {
    for (const chat of p.chats) {
      if (chat.sessionId === sessionId) return chat;
    }
  }
  return null;
}
```

- [ ] **Step 2: Cache tree data in fetchProjectTree**

Update `fetchProjectTree` to save data:

```javascript
async function fetchProjectTree() {
  try {
    const projectsRes = await fetch('/api/projects');
    const projects = projectsRes.ok ? await projectsRes.json() : [];

    const globalRes = await fetch('/api/projects/_global/sessions');
    const globalChats = globalRes.ok ? await globalRes.json() : [];

    const projectData = await Promise.all(projects.map(async (p) => {
      const res = await fetch(`/api/projects/${p.name}/sessions`);
      const chats = res.ok ? await res.json() : [];
      return { ...p, chats };
    }));

    cachedTreeData = { globalChats, projects: projectData };
    renderProjectTree(globalChats, projectData);
  } catch (err) {
    console.error('Failed to fetch project tree:', err);
  }
}
```

- [ ] **Step 3: Add breadcrumb project click handler**

```javascript
$('#breadcrumb-project').addEventListener('click', () => {
  // Show project info — switch to chats tab and expand project
  document.querySelector('.sidebar-tab[data-tab="chats"]').click();
  const sidebar = $('#sidebar');
  if (!sidebar.classList.contains('open') && window.innerWidth <= 640) {
    sidebar.classList.add('open');
    $('#sidebar-overlay').classList.add('open');
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat: breadcrumb session bar with project path"
```

---

### Task 9: Initial Load + Integration Cleanup

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Replace initial fetchSessions call**

Find `// Fetch sessions on load` and `fetchSessions();` (or `fetchProjectTree();` if already replaced) and ensure it calls `fetchProjectTree()`.

- [ ] **Step 2: Add viewingFile to sessionState**

```javascript
  viewingFile: null,
```

- [ ] **Step 3: Update sendTextMessage to use correct session API**

Verify `sendTextMessage` uses project-scoped URLs (already done in Task 9 of previous plan, but verify).

- [ ] **Step 4: Update new-session-btn to create in current project**

```javascript
$('#new-session-btn').addEventListener('click', () => {
  if (state.connected) {
    room.disconnect();
  }
  exitReadOnlyMode();
  // Stay in current project, just clear session for new chat
  sessionState.currentSessionId = null;
  sessionState.viewingSessionId = null;
  $('#conversation').innerHTML = '';
  closeSidebar();
  updateSessionBar();
});
```

- [ ] **Step 5: Full manual test**

1. Open http://localhost:3001
2. Verify tree sidebar shows 🏠 Home with existing chats
3. Create new project via "+ New Project"
4. Switch to project, verify breadcrumb updates
5. Create chat, verify it appears under project in tree
6. Switch to Files tab, verify file tree
7. Upload a file, verify it appears
8. Click a text file, verify inline viewer
9. Delete a chat (🗑), verify confirmation
10. Delete a project (✕), verify name confirmation
11. Resize sidebar, verify persistence
12. Test on mobile (resize browser to <640px)

- [ ] **Step 6: Commit**

```bash
git add web/app.js
git commit -m "feat: integration cleanup, initial load, new session in project"
```

---

### Task 10: Docs Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to Web UI section:
- Tree sidebar with collapsible projects
- Chats/Files tabs
- Resizable sidebar (drag, persisted in localStorage, min 200px, chat pane min 300px)
- File browser: tree view, text files inline, binary in new tab, upload
- Breadcrumb: project / chat path
- Project deletion with name confirmation
- Session deletion with confirmation

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for projects UI"
```
