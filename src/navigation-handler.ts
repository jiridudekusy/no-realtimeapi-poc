import { ProjectStore } from './project-store.js';
import { ProjectContext } from './project-context.js';
import { SessionStore } from './session-store.js';
import type { NavigationCommand } from './mcp/navigation-server.js';

export type ContextSwitchCallback = (projectName: string, sessionId: string | null) => Promise<void>;

export function createNavigationHandler(
  projectStore: ProjectStore,
  projectContext: ProjectContext,
  onContextSwitch: ContextSwitchCallback,
) {
  return async (cmd: NavigationCommand): Promise<string> => {
    switch (cmd.type) {
      case 'list_projects': {
        const projects = await projectStore.listProjects();
        if (projects.length === 0) {
          return 'No projects yet. You can create one by saying "create project <name>".';
        }
        const list = projects
          .map((p, i) => `${i + 1}. ${p.name}${p.description ? ` — ${p.description}` : ''}`)
          .join('\n');
        return `Available projects:\n${list}`;
      }

      case 'create_project': {
        try {
          const project = await projectStore.createProject(cmd.name, cmd.description);
          return `Project "${project.name}" created.${project.description ? ` Description: ${project.description}` : ''}`;
        } catch (err: any) {
          return `Failed to create project: ${err.message}`;
        }
      }

      case 'switch_project': {
        const project = await projectStore.getProject(cmd.projectName);
        if (!project) {
          return `Project "${cmd.projectName}" not found. Use list_projects to see available projects.`;
        }
        const targetSessions = new SessionStore(projectStore.getSessionsDir(cmd.projectName));
        await targetSessions.init();
        const chats = await targetSessions.listSessions();
        const recent = chats.slice(0, 5);

        let response = `Project: ${project.name}`;
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
        const targetProject = cmd.projectName || projectContext.currentProject;
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
        await onContextSwitch(cmd.projectName, cmd.chatId);
        return `Switched to chat in project "${cmd.projectName}".`;
      }

      case 'new_chat': {
        await onContextSwitch(cmd.projectName, null);
        return `New chat started in project "${cmd.projectName}".`;
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
