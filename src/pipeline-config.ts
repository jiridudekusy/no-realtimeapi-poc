import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface VadConfig { provider: string; minSilenceDuration?: number; }
export interface SttConfig { provider: string; model?: string; language?: string; }
export interface TtsConfig { provider: string; model?: string; voice?: string; }
export interface LlmConfig { provider: string; model: string; }
export interface PipelineConfig { vad: VadConfig; stt: SttConfig; tts: TtsConfig; llm: LlmConfig; }

const DEFAULTS: PipelineConfig = {
  vad: { provider: 'silero', minSilenceDuration: 1.5 },
  stt: { provider: 'deepgram', model: 'nova-3', language: 'cs' },
  tts: { provider: 'openai', model: 'tts-1', voice: 'nova' },
  llm: { provider: 'agent-sdk', model: 'claude-sonnet-4-6' },
};
export { DEFAULTS as PIPELINE_DEFAULTS };

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = result[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

async function loadJson(filePath: string): Promise<Partial<PipelineConfig>> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as Partial<PipelineConfig>;
  } catch {
    return {};
  }
}

export async function loadPipelineConfig(workspaceDir: string, projectName?: string): Promise<PipelineConfig> {
  let config: PipelineConfig = { ...DEFAULTS };

  const globalOverride = await loadJson(path.join(workspaceDir, 'pipeline.json'));
  config = deepMerge(config, globalOverride);

  if (projectName && projectName !== '_global') {
    const projectOverride = await loadJson(path.join(workspaceDir, projectName, 'pipeline.json'));
    config = deepMerge(config, projectOverride);
  }

  return config;
}
