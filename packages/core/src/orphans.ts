import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildImportGraph } from './graph.js';
import { CODE_EXTENSIONS, scanWorkspace } from './scanner.js';

export interface OrphanFileInfo {
  file: string;
  sizeBytes: number;
  estimatedTokens: number;
}

export interface OrphanFilesReport {
  rootDir: string;
  totalCodeFiles: number;
  orphans: OrphanFileInfo[];
  totalWastedTokens: number;
}

const ENTRYPOINT_BASENAMES = new Set([
  'index',
  'main',
  'app',
  'server',
  'cli',
  'extension',
  'mod',
  'lib',
  '__init__',
  'manage',
  'wsgi',
  'asgi',
  'setup',
  'conftest',
  'page',
  'layout',
  'route',
  'loading',
  'error',
  'not-found',
  'middleware',
  'instrumentation',
]);

const SKIP_PATH_RE =
  /(^|\/)(test|tests|__tests__|__mocks__|spec|specs|e2e|cypress|playwright|scripts|bin|pages|routes|api|migrations|prisma|examples|docs)\//i;
const SKIP_FILE_RE =
  /(\.(test|spec|stories|story|d|config|rc)\.[a-z0-9]+$|_test\.go$|^esbuild\.)/i;
const FRAMEWORK_ENTRY_RE =
  /@(SpringBootApplication|RestController|Controller|Service|Repository|Component|Configuration|Entity|Aspect|WebFilter|Scheduled)\b|\bpublic\s+static\s+void\s+main\s*\(|\bfunc\s+main\s*\(|\bif\s+__name__\s*==\s*['"]__main__['"]/;

async function collectPackageJsonRefs(rootDir: string): Promise<string> {
  try {
    return await readFile(path.join(rootDir, 'package.json'), 'utf8');
  } catch {
    return '';
  }
}

export async function findOrphanFiles(rootDir: string): Promise<OrphanFilesReport> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));
  const edges = await buildImportGraph(files, fileSet);
  const pkgRaw = await collectPackageJsonRefs(rootDir);

  const importedTargets = new Set<string>();
  for (const edge of edges) {
    if (edge.resolved && edge.resolved !== edge.from) {
      importedTargets.add(edge.resolved);
    }
  }

  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(f.ext));
  const orphans: OrphanFileInfo[] = [];

  await Promise.all(
    codeFiles.map(async (file) => {
      if (importedTargets.has(file.relPath)) return;
      if (SKIP_PATH_RE.test(file.relPath)) return;

      const base = path.basename(file.relPath);
      if (SKIP_FILE_RE.test(base)) return;

      const stem = path.basename(file.relPath, file.ext).toLowerCase();
      if (ENTRYPOINT_BASENAMES.has(stem)) return;

      // Skip files directly referenced in package.json (main/bin/exports/scripts)
      if (pkgRaw && (pkgRaw.includes(file.relPath) || pkgRaw.includes(base))) return;

      // Skip framework-wired entrypoints (Spring annotations, Java/Go/Python main)
      if (file.sizeBytes <= 200_000) {
        try {
          const content = await readFile(file.absPath, 'utf8');
          if (FRAMEWORK_ENTRY_RE.test(content)) return;
        } catch {
          return;
        }
      }

      orphans.push({
        file: file.relPath,
        sizeBytes: file.sizeBytes,
        estimatedTokens: Math.max(1, Math.ceil(file.sizeBytes / 4)),
      });
    })
  );

  orphans.sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.file.localeCompare(b.file));
  const totalWastedTokens = orphans.reduce((sum, o) => sum + o.estimatedTokens, 0);

  return {
    rootDir,
    totalCodeFiles: codeFiles.length,
    orphans,
    totalWastedTokens,
  };
}
