import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ProjectMeta {
  name: string;          // slug used for directory name (a-zA-Z0-9, -, .)
  displayName: string;   // user-entered name (can contain diacritics, special chars)
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
    if (!slug) throw new Error('Project name must contain at least one letter or number');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*$/.test(slug)) throw new Error('Directory name can only contain a-Z, 0-9 and hyphens');

    const existing = await this.getProject(slug);
    if (existing) throw new Error(`Project "${slug}" already exists`);

    const projectDir = path.join(this.#workspaceDir, slug);
    await mkdir(path.join(projectDir, 'sessions'), { recursive: true });

    if (!existsSync(path.join(projectDir, '.mcp.json'))) {
      await writeFile(path.join(projectDir, '.mcp.json'), '{}', 'utf-8');
    }

    const meta: ProjectMeta = {
      name: slug,
      displayName: name.trim(),
      description: description || null,
      created: new Date().toISOString(),
    };

    const projects = await this.listProjects();
    projects.push(meta);
    await writeFile(this.#indexPath, JSON.stringify(projects, null, 2), 'utf-8');

    return meta;
  }

  async updateProject(name: string, updates: { description?: string; displayName?: string }): Promise<void> {
    const projects = await this.listProjects();
    const project = projects.find(p => p.name === name);
    if (!project) throw new Error(`Project "${name}" not found`);
    if (updates.description !== undefined) project.description = updates.description;
    if (updates.displayName !== undefined) project.displayName = updates.displayName;
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
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // strip diacritics (č→c, ř→r, ž→z, …)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
