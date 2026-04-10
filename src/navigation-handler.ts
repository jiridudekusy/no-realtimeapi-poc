import { ProjectStore, type ProjectMeta } from './project-store.js';
import { ProjectContext } from './project-context.js';
import { SessionStore } from './session-store.js';
import type { NavigationCommand } from './mcp/navigation-server.js';

export type ContextSwitchCallback = (projectName: string, sessionId: string | null) => Promise<void>;

export function createNavigationHandler(
  projectStore: ProjectStore,
  projectContext: ProjectContext,
  onContextSwitch: ContextSwitchCallback,
) {
  // Resolve displayName or slug to slug
  async function resolveProject(name: string): Promise<ProjectMeta | null> {
    return projectStore.getProject(name); // getProject now matches by slug or displayName
  }

  return async (cmd: NavigationCommand): Promise<string> => {
    switch (cmd.type) {
      case 'list_projects': {
        const projects = await projectStore.listProjects();
        const current = projectContext.currentProject;
        const currentLabel = current === '_global' ? 'HOME (_global)' : current;
        if (projects.length === 0) {
          return `You are currently in: ${currentLabel}\nNo projects yet. You can create one by saying "create project <name>".`;
        }
        const list = projects
          .map((p, i) => {
            const active = p.name === current ? ' ← CURRENT' : '';
            return `${i + 1}. "${p.displayName || p.name}" (id: ${p.name})${p.description ? ` — ${p.description}` : ''}${active}`;
          })
          .join('\n');
        return `You are currently in: ${currentLabel}\n\nAvailable projects (use the id value for switch_project):\n${list}`;
      }

      case 'create_project': {
        try {
          const project = await projectStore.createProject(cmd.name, cmd.description);
          return `Project "${project.displayName}" created (directory: ${project.name}).${project.description ? ` Description: ${project.description}` : ''}`;
        } catch (err: any) {
          return `Failed to create project: ${err.message}`;
        }
      }

      case 'switch_project': {
        const project = await projectStore.getProject(cmd.projectName);
        if (!project) {
          return `Project "${cmd.projectName}" not found. Use list_projects to see available projects.`;
        }
        const slug = project.name; // always use slug for directory operations
        const targetSessions = new SessionStore(projectStore.getSessionsDir(slug));
        await targetSessions.init();
        const chats = await targetSessions.listSessions();
        const recent = chats.slice(0, 5);

        let response = `Project: ${project.displayName || project.name}`;
        if (project.description) response += `\nDescription: ${project.description}`;

        if (recent.length > 0) {
          response += `\n\nRecent chats:`;
          for (const chat of recent) {
            const age = getTimeAgo(chat.updated);
            response += `\n- "${chat.name || chat.preview}" (${age}, ${chat.messageCount} messages, ID: ${chat.sessionId})`;
          }
          response += '\n\nWant to continue one of these or start a new chat?';
        } else {
          response += '\n\nNo chats yet. Want to start a new chat?';
        }

        return response;
      }

      case 'list_chats': {
        let targetProject = cmd.projectName || projectContext.currentProject;
        // Resolve displayName → slug
        if (cmd.projectName) {
          const p = await resolveProject(cmd.projectName);
          if (p) targetProject = p.name;
        }
        let store;
        if (targetProject === projectContext.currentProject) {
          store = projectContext.sessionStore;
        } else {
          store = new SessionStore(projectStore.getSessionsDir(targetProject));
          await store.init();
        }
        let chats = await store.listSessions();
        if (cmd.hoursAgo) {
          const cutoff = Date.now() - cmd.hoursAgo * 60 * 60 * 1000;
          chats = chats.filter(c => new Date(c.updated).getTime() > cutoff);
        }
        if (cmd.count) {
          chats = chats.slice(0, cmd.count);
        }
        if (chats.length === 0) {
          return `No chats found in ${targetProject} matching your criteria.`;
        }
        const list = chats
          .map(c => {
            const age = getTimeAgo(c.updated);
            return `- "${c.name || c.preview}" (${age}, ${c.messageCount} messages, ID: ${c.sessionId})`;
          })
          .join('\n');
        return `Chats in ${targetProject}:\n${list}`;
      }

      case 'switch_chat': {
        const p = await resolveProject(cmd.projectName);
        const slug = p ? p.name : cmd.projectName;
        await onContextSwitch(slug, cmd.chatId);
        return `Switched to chat in project "${p?.displayName || slug}".`;
      }

      case 'new_chat': {
        const p = await resolveProject(cmd.projectName);
        const slug = p ? p.name : cmd.projectName;
        await onContextSwitch(slug, null);
        return `New chat started in project "${p?.displayName || slug}".`;
      }

      case 'go_back': {
        const entry = await projectContext.goBack();
        if (!entry) {
          return 'No previous context to return to.';
        }
        return `Returned to project "${entry.projectName}".`;
      }

      case 'go_home': {
        await onContextSwitch('_global', null);
        return 'Returned to home space.';
      }

      case 'rename_chat': {
        const session = projectContext.currentSession;
        if (!session) {
          return 'No active chat to rename.';
        }
        await projectContext.sessionStore.setName(session.sessionId, cmd.name);
        return `Chat renamed to "${cmd.name}".`;
      }

      default:
        return 'Unknown navigation command.';
    }
  };
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
