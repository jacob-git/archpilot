import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArchPilotConfig } from './types.js';

export const DEFAULT_CONFIG: ArchPilotConfig = {
  maxFileLines: 800,
  ignore: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    'target',
    'vendor',
    'DerivedData',
    'Pods',
    '.gradle',
    '.expo',
    '.swiftpm',
    'xcuserdata',
  ],
  boundaries: [],
};

export async function loadConfig(rootDir: string): Promise<{
  config: ArchPilotConfig;
  hasConfigFile: boolean;
}> {
  const configPath = path.join(rootDir, 'archpilot.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ArchPilotConfig>;
    return {
      hasConfigFile: true,
      config: {
        maxFileLines:
          typeof parsed.maxFileLines === 'number' && parsed.maxFileLines > 0
            ? parsed.maxFileLines
            : DEFAULT_CONFIG.maxFileLines,
        ignore: Array.isArray(parsed.ignore)
          ? Array.from(new Set([...DEFAULT_CONFIG.ignore, ...parsed.ignore]))
          : DEFAULT_CONFIG.ignore,
        boundaries: Array.isArray(parsed.boundaries) ? parsed.boundaries : [],
      },
    };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, hasConfigFile: false };
  }
}
