import { mkdir, cp, readdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function initWorkspace(workspaceDir: string): Promise<void> {
  const globalDir = path.join(workspaceDir, '_global');
  const globalSessionsDir = path.join(globalDir, 'sessions');

  if (!existsSync(globalSessionsDir)) {
    await mkdir(globalSessionsDir, { recursive: true });
  }

  const mcpPath = path.join(globalDir, '.mcp.json');
  if (!existsSync(mcpPath)) {
    await writeFile(mcpPath, '{}', 'utf-8');
  }

  const claudeMdPath = path.join(globalDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    await writeFile(claudeMdPath, '# Global Assistant Instructions\n\nRespond in the language the user speaks.\n', 'utf-8');
  }

  const indexPath = path.join(globalSessionsDir, 'index.json');
  if (!existsSync(indexPath)) {
    await writeFile(indexPath, '[]', 'utf-8');
  }

  const projectsPath = path.join(workspaceDir, 'projects.json');
  if (!existsSync(projectsPath)) {
    await writeFile(projectsPath, '[]', 'utf-8');
  }

  const pipelinePath = path.join(workspaceDir, 'pipeline.json');
  if (!existsSync(pipelinePath)) {
    const defaultPipeline = {
      vad: { provider: 'silero', minSilenceDuration: 1.5 },
      stt: { provider: 'deepgram', model: 'nova-3', language: 'cs' },
      tts: { provider: 'openai', model: 'tts-1', voice: 'nova' },
      llm: { provider: 'agent-sdk', model: 'claude-sonnet-4-6' },
    };
    await writeFile(pipelinePath, JSON.stringify(defaultPipeline, null, 2), 'utf-8');
  }

  console.log(`[Workspace] Initialized at ${workspaceDir}`);
}

export async function migrateOldSessions(
  oldSessionsDir: string,
  workspaceDir: string,
): Promise<void> {
  const targetDir = path.join(workspaceDir, '_global', 'sessions');

  if (!existsSync(oldSessionsDir)) return;

  const targetIndex = path.join(targetDir, 'index.json');
  if (existsSync(targetIndex)) {
    try {
      const data = await readFile(targetIndex, 'utf-8');
      const index = JSON.parse(data);
      if (index.length > 0) {
        console.log('[Workspace] Sessions already migrated, skipping');
        return;
      }
    } catch {}
  }

  try {
    const files = await readdir(oldSessionsDir);
    for (const file of files) {
      const src = path.join(oldSessionsDir, file);
      const dst = path.join(targetDir, file);
      if (!existsSync(dst)) {
        await cp(src, dst);
      }
    }
    console.log(`[Workspace] Migrated ${files.length} files from ${oldSessionsDir} to ${targetDir}`);
  } catch (err) {
    console.error('[Workspace] Migration failed:', err);
  }
}
