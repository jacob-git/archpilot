import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { auditRepository } from './audit.js';
import { loadConfig } from './config.js';
import { buildImportGraph } from './graph.js';
import { scanWorkspace, toPosix } from './scanner.js';
import type { Finding } from './types.js';

const execFileAsync = promisify(execFile);

export interface BlastRadiusReport {
  rootDir: string;
  changedFiles: string[];
  directDependents: string[];
  transitiveDependents: string[];
  impactedModules: string[];
  riskLevel: 'low' | 'medium' | 'high';
  diffFindings: Finding[];
}

async function detectGitChangedFiles(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: rootDir,
    });
    const dirty = stdout
      .split(/\r?\n/)
      .filter((line) => line.length >= 4)
      .map((line) => {
        const raw = line.slice(3).trim();
        const arrowIdx = raw.indexOf(' -> ');
        return toPosix(arrowIdx !== -1 ? raw.slice(arrowIdx + 4) : raw);
      })
      .filter(Boolean);

    if (dirty.length > 0) {
      return Array.from(new Set(dirty));
    }

    // Fallback: compare last commit if working tree is clean
    const diffOut = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: rootDir,
    });
    return Array.from(
      new Set(
        diffOut.stdout
          .split(/\r?\n/)
          .map((l) => toPosix(l.trim()))
          .filter(Boolean)
      )
    );
  } catch {
    return [];
  }
}

function moduleOf(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0];
  return '(root)';
}

export async function analyzeBlastRadius(
  rootDir: string,
  explicitChangedFiles?: string[]
): Promise<BlastRadiusReport> {
  const resolvedRoot = path.resolve(rootDir);
  const changedFiles =
    explicitChangedFiles && explicitChangedFiles.length > 0
      ? Array.from(new Set(explicitChangedFiles.map(toPosix)))
      : await detectGitChangedFiles(resolvedRoot);

  const changedSet = new Set(changedFiles);
  const { config } = await loadConfig(resolvedRoot);
  const files = await scanWorkspace(resolvedRoot, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));
  const edges = await buildImportGraph(files, fileSet);

  // Build reverse adjacency map: target -> files importing target
  const reverseAdj = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.resolved || edge.resolved === edge.from) continue;
    const set = reverseAdj.get(edge.resolved) ?? new Set<string>();
    set.add(edge.from);
    reverseAdj.set(edge.resolved, set);
  }

  const directSet = new Set<string>();
  const transitiveSet = new Set<string>();
  const queue: string[] = [];

  for (const cf of changedFiles) {
    for (const dep of reverseAdj.get(cf) ?? []) {
      if (!changedSet.has(dep)) {
        directSet.add(dep);
        if (!transitiveSet.has(dep)) {
          transitiveSet.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const next of reverseAdj.get(curr) ?? []) {
      if (!changedSet.has(next) && !transitiveSet.has(next)) {
        transitiveSet.add(next);
        queue.push(next);
      }
    }
  }

  const audit = await auditRepository(resolvedRoot);
  const diffFindings = audit.findings.filter((f) => f.file && changedSet.has(f.file));

  const directDependents = Array.from(directSet).sort();
  const transitiveDependents = Array.from(transitiveSet).sort();
  const impactedModules = Array.from(
    new Set([...changedFiles, ...transitiveDependents].map(moduleOf))
  ).sort();

  const hasErrorInDiff = diffFindings.some((f) => f.severity === 'error');
  const riskLevel: BlastRadiusReport['riskLevel'] =
    hasErrorInDiff || transitiveDependents.length > 12
      ? 'high'
      : transitiveDependents.length >= 4
        ? 'medium'
        : 'low';

  return {
    rootDir: resolvedRoot,
    changedFiles,
    directDependents,
    transitiveDependents,
    impactedModules,
    riskLevel,
    diffFindings,
  };
}
