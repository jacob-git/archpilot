import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScannedFile } from './types.js';
import { toPosix } from './scanner.js';

const TS_JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface ImportEdge {
  from: string;
  specifier: string;
  resolved?: string;
  line: number;
}

const TS_IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_FROM_RE = /^\s*from\s+(\.+[a-zA-Z0-9_.]*|[a-zA-Z0-9_.]+)\s+import\b/;
const PY_IMPORT_RE = /^\s*import\s+([a-zA-Z0-9_.]+)/;
const JAVA_IMPORT_RE = /^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+)\s*;/;
const GO_IMPORT_LINE_RE = /^\s*(?:[a-zA-Z0-9_.]+\s+)?"([^"]+)"/;
const RUST_USE_RE = /^\s*(?:pub\s+)?use\s+(crate::[a-zA-Z0-9_:]+)/;
const RUST_MOD_RE = /^\s*(?:pub\s+)?mod\s+([a-zA-Z0-9_]+)\s*;/;

export function extractImports(
  content: string,
  ext = '.ts'
): Array<{ specifier: string; line: number }> {
  const edges: Array<{ specifier: string; line: number }> = [];
  const lines = content.split(/\r?\n/);

  if (TS_JS_EXTS.has(ext)) {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText.trimStart().startsWith('//')) continue;
      TS_IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TS_IMPORT_RE.exec(lineText)) !== null) {
        const specifier = match[1] ?? match[2];
        if (specifier) edges.push({ specifier, line: i + 1 });
      }
    }
    return edges;
  }

  if (ext === '.py') {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText.trimStart().startsWith('#')) continue;
      const fromMatch = PY_FROM_RE.exec(lineText);
      if (fromMatch) {
        edges.push({ specifier: fromMatch[1], line: i + 1 });
        continue;
      }
      const impMatch = PY_IMPORT_RE.exec(lineText);
      if (impMatch) {
        edges.push({ specifier: impMatch[1], line: i + 1 });
      }
    }
    return edges;
  }

  if (ext === '.java') {
    for (let i = 0; i < lines.length; i++) {
      const m = JAVA_IMPORT_RE.exec(lines[i]);
      if (m) edges.push({ specifier: m[1], line: i + 1 });
    }
    return edges;
  }

  if (ext === '.go') {
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('import (')) {
        inBlock = true;
        continue;
      }
      if (inBlock && trimmed.startsWith(')')) {
        inBlock = false;
        continue;
      }
      if (inBlock) {
        const m = GO_IMPORT_LINE_RE.exec(trimmed);
        if (m) edges.push({ specifier: m[1], line: i + 1 });
      } else if (trimmed.startsWith('import ')) {
        const m = /"([^"]+)"/.exec(trimmed);
        if (m) edges.push({ specifier: m[1], line: i + 1 });
      }
    }
    return edges;
  }

  if (ext === '.rs') {
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText.trimStart().startsWith('//')) continue;
      const useMatch = RUST_USE_RE.exec(lineText);
      if (useMatch) {
        edges.push({ specifier: useMatch[1], line: i + 1 });
        continue;
      }
      const modMatch = RUST_MOD_RE.exec(lineText);
      if (modMatch) {
        edges.push({ specifier: `mod::${modMatch[1]}`, line: i + 1 });
      }
    }
  }

  return edges;
}

function resolveTsJsImport(
  fromRelPath: string,
  specifier: string,
  fileSet: Set<string>
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const fromDir = path.posix.dirname(fromRelPath);
  const rawTarget = path.posix.normalize(path.posix.join(fromDir, specifier));

  const candidates = new Set<string>([rawTarget]);
  if (rawTarget.endsWith('.js')) {
    const base = rawTarget.slice(0, -3);
    candidates.add(`${base}.ts`);
    candidates.add(`${base}.tsx`);
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.add(`${rawTarget}${ext}`);
    candidates.add(toPosix(path.posix.join(rawTarget, `index${ext}`)));
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

function resolvePythonImport(
  fromRelPath: string,
  specifier: string,
  fileSet: Set<string>
): string | undefined {
  let basePath: string;
  if (specifier.startsWith('.')) {
    const dotsMatch = /^(\.+)(.*)$/.exec(specifier);
    if (!dotsMatch) return undefined;
    const upLevels = dotsMatch[1].length - 1;
    let dir = path.posix.dirname(fromRelPath);
    for (let i = 0; i < upLevels; i++) {
      dir = path.posix.dirname(dir);
    }
    const rest = dotsMatch[2].replace(/\./g, '/');
    basePath = rest ? path.posix.normalize(path.posix.join(dir, rest)) : dir;
  } else {
    basePath = specifier.replace(/\./g, '/');
  }

  const candidates = [
    `${basePath}.py`,
    `${basePath}/__init__.py`,
    `src/${basePath}.py`,
    `src/${basePath}/__init__.py`,
  ];
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

function resolveJavaImport(
  specifier: string,
  javaSuffixMap: Map<string, string>
): string | undefined {
  const clean = specifier.replace(/\.\*$/, '');
  const asPath = `${clean.replace(/\./g, '/')}.java`;
  return javaSuffixMap.get(asPath);
}

function resolveRustImport(
  fromRelPath: string,
  specifier: string,
  fileSet: Set<string>
): string | undefined {
  if (specifier.startsWith('mod::')) {
    const modName = specifier.slice(5);
    const dir = path.posix.dirname(fromRelPath);
    const c1 = path.posix.normalize(path.posix.join(dir, `${modName}.rs`));
    const c2 = path.posix.normalize(path.posix.join(dir, modName, 'mod.rs'));
    if (fileSet.has(c1)) return c1;
    if (fileSet.has(c2)) return c2;
    return undefined;
  }
  if (specifier.startsWith('crate::')) {
    const parts = specifier.slice(7).split('::');
    for (let len = parts.length; len >= 1; len--) {
      const sub = parts.slice(0, len).join('/');
      const c1 = `src/${sub}.rs`;
      const c2 = `src/${sub}/mod.rs`;
      if (fileSet.has(c1)) return c1;
      if (fileSet.has(c2)) return c2;
    }
  }
  return undefined;
}

function resolveGoImport(
  specifier: string,
  goDirMap: Map<string, string>
): string | undefined {
  // Match longest suffix of specifier against repo directories containing .go files
  const parts = specifier.split('/');
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    const match = goDirMap.get(suffix);
    if (match) return match;
  }
  return undefined;
}

const GRAPH_EXTS = new Set([...TS_JS_EXTS, '.py', '.java', '.go', '.rs']);

export async function buildImportGraph(
  files: ScannedFile[],
  fileSet: Set<string>
): Promise<ImportEdge[]> {
  const edges: ImportEdge[] = [];
  const targetFiles = files.filter((f) => GRAPH_EXTS.has(f.ext));

  // Pre-index Java class paths and Go package directories for O(1) lookup
  const javaSuffixMap = new Map<string, string>();
  const goDirMap = new Map<string, string>();
  for (const f of targetFiles) {
    if (f.ext === '.java') {
      const idx = f.relPath.indexOf('src/main/java/');
      const suffix = idx !== -1 ? f.relPath.slice(idx + 'src/main/java/'.length) : f.relPath;
      javaSuffixMap.set(suffix, f.relPath);
    } else if (f.ext === '.go' && !f.relPath.endsWith('_test.go')) {
      const dir = path.posix.dirname(f.relPath);
      if (dir !== '.' && !goDirMap.has(dir)) {
        goDirMap.set(dir, f.relPath);
      }
    }
  }

  await Promise.all(
    targetFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }
      const specs = extractImports(content, file.ext);
      for (const { specifier, line } of specs) {
        let resolved: string | undefined;
        if (TS_JS_EXTS.has(file.ext)) {
          resolved = resolveTsJsImport(file.relPath, specifier, fileSet);
        } else if (file.ext === '.py') {
          resolved = resolvePythonImport(file.relPath, specifier, fileSet);
        } else if (file.ext === '.java') {
          resolved = resolveJavaImport(specifier, javaSuffixMap);
        } else if (file.ext === '.rs') {
          resolved = resolveRustImport(file.relPath, specifier, fileSet);
        } else if (file.ext === '.go') {
          resolved = resolveGoImport(specifier, goDirMap);
        }
        edges.push({
          from: file.relPath,
          specifier,
          resolved,
          line,
        });
      }
    })
  );

  return edges;
}

export function detectCycles(edges: ImportEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.resolved || edge.resolved === edge.from) continue;
    const list = adj.get(edge.from) ?? [];
    list.push(edge.resolved);
    adj.set(edge.from, list);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];
  const cycles: string[][] = [];
  const seenSignatures = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    for (const next of adj.get(node) ?? []) {
      if (!visited.has(next)) {
        dfs(next);
      } else if (stack.has(next)) {
        const startIdx = pathStack.indexOf(next);
        if (startIdx !== -1) {
          const cycle = [...pathStack.slice(startIdx), next];
          const sig = [...cycle.slice(0, -1)].sort().join('->');
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            cycles.push(cycle);
          }
        }
      }
    }

    pathStack.pop();
    stack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}
