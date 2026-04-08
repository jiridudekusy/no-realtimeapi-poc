import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ProjectMeta {
  name: string;
  description: string | null;
  created: string;
}

export class ProjectStore {
  #workspaceDir: string;
  #indexPath: string;

  constructor(workspaceDir: string) {
    this.#workspaceDir = workspaceDir;
    this.#indexPath = path.join(workspaceDir, 'projects.json');
  }

  get workspaceDir(): string {
    return this.#workspaceDir;
  }

  async init(): Promise<void> {
    if (!existsSync(this.#workspaceDir)) {
      await mkdir(this.#workspaceDir, { recursive: true });
    }
    if (!existsSync(this.#indexPath)) {
      await writeFile(this.#indexPath, '[]', 'utf-8');
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    try {
      const data = await readFile(this.#indexPath, 'utf-8');
      return JSON.parse(data) as ProjectMeta[];
    } catch {
      return [];
    }
  }

  async getProject(name: string): Promise<ProjectMeta | null> {
    const projects = await this.listProjects();
    return projects.find(p => p.name === name) || null;
  }

  async createProject(name: string, description?: string): Promise<ProjectMeta> {
    const slug = this.#slugify(name);
    if (slug === '_global') throw new Error('_global is reserved');

    const existing = await this.getProject(slug);
    if (existing) throw new Error(`Project "${slug}" already exists`);

    const projectDir = path.join(this.#workspaceDir, slug);
    await mkdir(path.join(projectDir, 'sessions'), { recursive: true });

    if (!existsSync(path.join(projectDir, '.mcp.json'))) {
      await writeFile(path.join(projectDir, '.mcp.json'), '{}', 'utf-8');
    }

    const meta: ProjectMeta = {
      name: slug,
      description: description || null,
      created: new Date().toISOString(),
    };

    const projects = await this.listProjects();
    projects.push(meta);
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');

    return meta;
  }

  async updateProject(name: string, updates: { description?: string }): Promise<void> {
    const projects = await this.listProjects();
    const project = projects.find(p => p.name === name);
    if (!project) throw new Error(`Project "${name}" not found`);
    if (updates.description !== undefined) project.description = updates.description;
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');
  }

  async deleteProject(name: string): Promise<void> {
    if (name === '_global') throw new Error('Cannot delete _global');
    const projects = await this.listProjects();
    const idx = projects.findIndex(p => p.name === name);
    if (idx === -1) throw new Error(`Project "${name}" not found`);

    const projectDir = this.getProjectDir(name);
    const { rm } = await import('node:fs/promises');
    await rm(projectDir, { recursive: true, force: true });

    projects.splice(idx, 1);
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');
  }

  getProjectDir(projectName: string): string {
    return path.join(this.#workspaceDir, projectName);
  }

  getSessionsDir(projectName: string): string {
    return path.join(this.#workspaceDir, projectName, 'sessions');
  }

  #slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
