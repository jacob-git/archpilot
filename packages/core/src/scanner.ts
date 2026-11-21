import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ScannedFile } from './types.js';

export const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.cs',
  '.rb',
  '.php',
  '.kt',
  '.swift',
]);

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

interface IgnoreMatcher {
  dirOnly: boolean;
  hasSlash: boolean;
  regex: RegExp;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§§/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function parseIgnoreFile(content: string): IgnoreMatcher[] {
  const matchers: IgnoreMatcher[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continue;
    }
    const dirOnly = trimmed.endsWith('/');
    const cleaned = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) continue;
    const hasSlash = cleaned.includes('/');
    matchers.push({
      dirOnly,
      hasSlash,
      regex: globToRegex(cleaned),
    });
  }
  return matchers;
}

async function loadIgnoreMatchers(rootDir: string): Promise<IgnoreMatcher[]> {
  const files = ['.gitignore', '.aiignore', '.cursorignore'];
  const all: IgnoreMatcher[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(rootDir, file), 'utf8');
      all.push(...parseIgnoreFile(content));
    } catch {
      // file does not exist
    }
  }
  return all;
}

function isIgnored(
  relPath: string,
  name: string,
  isDir: boolean,
  matchers: IgnoreMatcher[]
): boolean {
  for (const m of matchers) {
    if (m.dirOnly && !isDir) {
      continue;
    }
    if (m.hasSlash) {
      if (m.regex.test(relPath)) return true;
    } else {
      if (m.regex.test(name) || m.regex.test(relPath)) return true;
    }
  }
  return false;
}

export async function scanWorkspace(
  rootDir: string,
  ignoreEntries: string[]
): Promise<ScannedFile[]> {
  const ignoreSet = new Set(ignoreEntries);
  const configMatchers = parseIgnoreFile(ignoreEntries.join('\n'));
  const ignoreMatchers = [...configMatchers, ...(await loadIgnoreMatchers(rootDir))];
  const results: ScannedFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = toPosix(path.relative(rootDir, absPath));

      if (entry.isDirectory()) {
        if (
          ignoreSet.has(entry.name) ||
          isIgnored(relPath, entry.name, true, ignoreMatchers)
        ) {
          continue;
        }
        await walk(absPath);
      } else if (entry.isFile()) {
        if (isIgnored(relPath, entry.name, false, ignoreMatchers)) {
          continue;
        }
        let sizeBytes = 0;
        try {
          const st = await stat(absPath);
          sizeBytes = st.size;
        } catch {
          // ignore stat errors
        }
        results.push({
          relPath,
          absPath,
          ext: path.extname(entry.name).toLowerCase(),
          sizeBytes,
        });
      }
    }
  }

  await walk(rootDir);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}
