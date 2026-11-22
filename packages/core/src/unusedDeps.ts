import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildImportGraph } from './graph.js';
import { scanWorkspace } from './scanner.js';

export interface UnusedDependencyInfo {
  name: string;
  version: string;
  packageJsonPath: string;
}

export interface UnusedDepsReport {
  rootDir: string;
  totalDependencies: number;
  unused: UnusedDependencyInfo[];
}

const IMPLICIT_RUNTIME_DEPS = new Set([
  'tslib',
  'reflect-metadata',
  'zone.js',
  'core-js',
  'regenerator-runtime',
  'dotenv',
]);

function normalizePackageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

export async function findUnusedDependencies(rootDir: string): Promise<UnusedDepsReport> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));
  const edges = await buildImportGraph(files, fileSet);

  const usedPackages = new Set<string>();
  for (const edge of edges) {
    const pkg = normalizePackageName(edge.specifier);
    if (pkg) usedPackages.add(pkg);
  }

  // Also check config files, CSS imports, and package.json scripts for indirect references
  const extraTextChunks: string[] = [];
  const configFiles = files.filter((f) =>
    /(^|\/)((next|vite|webpack|babel|postcss|tailwind|eslint|jest|vitest|svelte|nuxt|astro)\.config\.|\.(babelrc|eslintrc|postcssrc))|\.(css|scss|less)$/i.test(
      f.relPath
    )
  );
  await Promise.all(
    configFiles.slice(0, 40).map(async (f) => {
      if (f.sizeBytes > 150_000) return;
      try {
        extraTextChunks.push(await readFile(f.absPath, 'utf8'));
      } catch {
        // ignore
      }
    })
  );

  const pkgFiles = files.filter(
    (f) => path.basename(f.relPath) === 'package.json' && f.relPath.split('/').length <= 3
  );

  let totalDependencies = 0;
  const unused: UnusedDependencyInfo[] = [];

  for (const pkgFile of pkgFiles) {
    let parsed: {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    try {
      parsed = JSON.parse(await readFile(pkgFile.absPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
    } catch {
      continue;
    }

    const scriptsBlob = Object.values(parsed.scripts ?? {}).join('\n');
    const searchBlob = `${scriptsBlob}\n${extraTextChunks.join('\n')}`;

    for (const [depName, version] of Object.entries(parsed.dependencies ?? {})) {
      totalDependencies += 1;
      if (depName.startsWith('@types/') || IMPLICIT_RUNTIME_DEPS.has(depName)) continue;
      if (usedPackages.has(depName)) continue;
      if (searchBlob.includes(depName)) continue;

      unused.push({
        name: depName,
        version,
        packageJsonPath: pkgFile.relPath,
      });
    }
  }

  unused.sort((a, b) => a.packageJsonPath.localeCompare(b.packageJsonPath) || a.name.localeCompare(b.name));

  return {
    rootDir: path.resolve(rootDir),
    totalDependencies,
    unused,
  };
}
