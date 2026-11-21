import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CODE_EXTENSIONS, scanWorkspace } from './scanner.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { buildImportGraph } from './graph.js';
import { detectStack } from './stack.js';
import type { AuditReport, BoundaryRule, Finding } from './types.js';

export async function generateAgentsMd(rootDir: string): Promise<string> {
  const repoName = path.basename(path.resolve(rootDir));
  const files = await scanWorkspace(rootDir, DEFAULT_CONFIG.ignore);

  let scriptsSection = '- Add your build, test, and lint commands here.';
  try {
    const rawPkg = await readFile(path.join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(rawPkg) as { scripts?: Record<string, string> };
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      scriptsSection = Object.entries(pkg.scripts)
        .map(([name, cmd]) => `- \`npm run ${name}\` — \`${cmd}\``)
        .join('\n');
    }
  } catch {
    // non-Node repo
  }

  const topDirs = Array.from(
    new Set(
      files
        .map((f) => f.relPath.split('/')[0])
        .filter((seg) => !seg.startsWith('.') && files.some((f) => f.relPath.startsWith(`${seg}/`)))
    )
  ).sort();

  const layoutSection =
    topDirs.length > 0
      ? topDirs.map((d) => `- \`${d}/\` — TODO: describe module responsibility`).join('\n')
      : '- Describe your primary source directories here.';

  return `# AGENTS.md — ${repoName}

## Overview
Concise engineering guide for AI coding agents working in **${repoName}**.

## Commands
${scriptsSection}

## Repository Layout
${layoutSection}

## Architecture Guardrails
- Follow module boundaries defined in \`archpilot.json\`.
- Keep files focused and modular (avoid mega-files > ${DEFAULT_CONFIG.maxFileLines} lines).
- Always run tests and typechecks before finishing a task.
`;
}

export function generateArchPilotConfig(): string {
  return (
    JSON.stringify(
      {
        maxFileLines: 800,
        ignore: ['node_modules', 'dist', 'build', 'coverage'],
        boundaries: [
          {
            name: 'example-layer-boundary',
            from: 'src/domain',
            disallow: ['src/ui', 'src/infra'],
            message: 'Domain layer must not depend on UI or infrastructure.',
          },
        ],
      },
      null,
      2
    ) + '\n'
  );
}

export async function generateSmartArchPilotConfig(rootDir: string): Promise<string> {
  const resolvedRoot = path.resolve(rootDir);
  const files = await scanWorkspace(resolvedRoot, DEFAULT_CONFIG.ignore);
  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(f.ext));

  // Collect all unique directory prefixes up to depth 4
  const dirSet = new Set<string>();
  for (const f of codeFiles) {
    const parts = f.relPath.split('/');
    for (let i = 1; i < Math.min(parts.length, 5); i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  const dirs = Array.from(dirSet).sort();

  const findDirs = (names: string[]): string[] => {
    const set = new Set(names);
    return dirs.filter((d) => {
      const leaf = path.posix.basename(d).toLowerCase();
      return set.has(leaf);
    });
  };

  const boundaries: BoundaryRule[] = [];
  const seenKeys = new Set<string>();
  const addRule = (rule: BoundaryRule): void => {
    const disallow = rule.disallow.filter((d) => d !== rule.from);
    if (disallow.length === 0) return;
    const key = `${rule.from}->${disallow.sort().join(',')}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    boundaries.push({ ...rule, disallow });
  };

  // 1. Domain / Core isolation
  const domainDirs = findDirs(['domain', 'core', 'entities', 'models']);
  const outerDirs = findDirs([
    'ui',
    'components',
    'pages',
    'views',
    'controllers',
    'controller',
    'routes',
    'api',
    'infra',
    'infrastructure',
    'db',
    'database',
  ]);
  for (const dom of domainDirs) {
    // Only disallow sibling/outer dirs that aren't ancestors/descendants of dom
    const disallowed = outerDirs.filter(
      (o) => !dom.startsWith(`${o}/`) && !o.startsWith(`${dom}/`)
    );
    addRule({
      name: 'domain-isolation',
      from: dom,
      disallow: disallowed.slice(0, 6),
      message: `Core/domain module \`${dom}\` must not depend on UI, API, or infrastructure layers.`,
    });
  }

  // 2. UI / Frontend must not import DB / Repositories directly
  const uiDirs = findDirs(['ui', 'components', 'views', 'pages']);
  const dataDirs = findDirs(['db', 'database', 'repositories', 'repository', 'prisma', 'drizzle']);
  for (const ui of uiDirs) {
    const disallowed = dataDirs.filter(
      (d) => !ui.startsWith(`${d}/`) && !d.startsWith(`${ui}/`)
    );
    addRule({
      name: 'ui-no-direct-db',
      from: ui,
      disallow: disallowed,
      message: `UI layer \`${ui}\` must not import database/repository modules directly.`,
    });
  }

  // 3. Spring / Backend Controller -> Service -> Repository
  const controllerDirs = findDirs(['controller', 'controllers', 'routes']);
  const repoDirs = findDirs(['repository', 'repositories', 'dao']);
  const serviceDirs = findDirs(['service', 'services']);
  if (controllerDirs.length > 0 && serviceDirs.length > 0 && repoDirs.length > 0) {
    for (const ctrl of controllerDirs) {
      addRule({
        name: 'controller-uses-service',
        from: ctrl,
        disallow: repoDirs,
        message: `Controller \`${ctrl}\` should call Services instead of importing Repositories directly.`,
      });
    }
    for (const repo of repoDirs) {
      addRule({
        name: 'repository-isolation',
        from: repo,
        disallow: [...controllerDirs, ...serviceDirs],
        message: `Repository \`${repo}\` must not depend on Controller or Service layers.`,
      });
    }
  }

  // 4. Shared / Utils must not import feature/page/app modules
  const sharedDirs = findDirs(['shared', 'common', 'utils', 'lib']);
  const appDirs = findDirs(['features', 'pages', 'app', 'routes', 'controllers']);
  for (const sh of sharedDirs) {
    const disallowed = appDirs.filter(
      (a) => !sh.startsWith(`${a}/`) && !a.startsWith(`${sh}/`)
    );
    addRule({
      name: 'shared-no-app-imports',
      from: sh,
      disallow: disallowed.slice(0, 6),
      message: `Shared module \`${sh}\` must not depend on higher-level feature or app layers.`,
    });
  }

  // 5. Monorepo packages/core or packages/shared isolation
  const pkgChildren = dirs.filter((d) => /^packages\/[^/]+$/.test(d));
  const appChildren = dirs.filter((d) => /^apps\/[^/]+$/.test(d));
  for (const pkg of pkgChildren) {
    if (pkg.endsWith('/core') || pkg.endsWith('/shared') || pkg.endsWith('/common')) {
      const others = [...pkgChildren.filter((p) => p !== pkg), ...appChildren];
      addRule({
        name: 'monorepo-core-purity',
        from: pkg,
        disallow: others,
        message: `Shared workspace package \`${pkg}\` must stay independent of apps and sibling wrappers.`,
      });
    }
  }

  // Fallback if flat repo
  if (boundaries.length === 0) {
    const topDir = dirs[0] ?? 'src';
    boundaries.push({
      name: 'custom-boundary-example',
      from: `${topDir}/core`,
      disallow: [`${topDir}/ui`],
      message: 'Customize these paths to enforce your repository module boundaries.',
    });
  }

  return (
    JSON.stringify(
      {
        maxFileLines: 800,
        maxInstructionTokens: 3000,
        maxFileTokens: 12000,
        ignore: ['node_modules', 'dist', 'build', 'coverage'],
        boundaries: boundaries.slice(0, 8),
      },
      null,
      2
    ) + '\n'
  );
}

export function generateGitignore(): string {
  return `node_modules/
dist/
build/
out/
coverage/
.env
.env.local
.DS_Store
*.log
`;
}

export function generateReadmeBadge(report: AuditReport): string {
  const color =
    report.overallScore >= 90
      ? 'brightgreen'
      : report.overallScore >= 80
        ? 'green'
        : report.overallScore >= 70
          ? 'yellow'
          : report.overallScore >= 60
            ? 'orange'
            : 'red';
  const label = encodeURIComponent(`${report.overallScore}/100 (${report.grade})`);
  return `[![ArchPilot Score](https://img.shields.io/badge/ArchPilot-${label}-${color})](https://github.com/jacob-git/archpilot)`;
}

export function generateFixPrompt(report: AuditReport, singleFinding?: Finding): string {
  const repoName = path.basename(report.rootDir);
  const targets = singleFinding ? [singleFinding] : report.findings;

  if (targets.length === 0) {
    return `ArchPilot reported 0 issues for ${repoName} (${report.overallScore}/100, Grade ${report.grade}).`;
  }

  const lines = [
    `Please fix the following ArchPilot architecture & AI-readiness issue${targets.length > 1 ? 's' : ''} in **${repoName}**:`,
    '',
  ];

  for (const f of targets) {
    const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
    lines.push(`- **[${f.severity.toUpperCase()}] \`${f.id}\`**${loc}: ${f.message}`);
    if (f.suggestion) {
      lines.push(`  - Suggested fix: ${f.suggestion}`);
    }
  }

  lines.push(
    '',
    'After making changes, verify that tests and typechecks pass and re-run `archpilot` to confirm the issues are resolved.'
  );

  return lines.join('\n');
}

export async function generateArchMap(rootDir: string): Promise<string> {
  const resolvedRoot = path.resolve(rootDir);
  const repoName = path.basename(resolvedRoot);
  const { config } = await loadConfig(resolvedRoot);
  const files = await scanWorkspace(resolvedRoot, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));

  let packageJson: Record<string, unknown> | undefined;
  if (fileSet.has('package.json')) {
    try {
      packageJson = JSON.parse(
        await readFile(path.join(resolvedRoot, 'package.json'), 'utf8')
      ) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  const stack = await detectStack(resolvedRoot, files, fileSet, packageJson);
  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(f.ext));
  const edges = await buildImportGraph(files, fileSet);

  // Group code files by top 2 path segments (e.g., packages/core, src/api)
  const moduleCounts = new Map<string, number>();
  const entryPoints: string[] = [];
  for (const f of codeFiles) {
    const parts = f.relPath.split('/');
    const mod = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);

    const base = path.posix.basename(f.relPath).toLowerCase();
    if (
      /^(?:index|main|app|server|extension|application)\.[a-z0-9]+$/.test(base) ||
      /controller\.java$/i.test(base)
    ) {
      entryPoints.push(f.relPath);
    }
  }

  // Compute most-imported internal hub files (high in-degree)
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    if (!edge.resolved) continue;
    inDegree.set(edge.resolved, (inDegree.get(edge.resolved) ?? 0) + 1);
  }
  const topHubs = Array.from(inDegree.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const stackLine = [
    ...stack.languages,
    ...stack.frameworks,
    ...stack.capabilities,
  ].join(', ');

  const out: string[] = [
    `# ARCHMAP.md — ${repoName}`,
    '',
    '> Compact architecture index generated by ArchPilot. Read this first to locate modules without scanning the whole repo.',
    '',
    `- **Stack:** ${stackLine || 'generic'}`,
    `- **Code Files:** ${codeFiles.length}`,
    '',
    '## Modules',
  ];

  const sortedMods = Array.from(moduleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [mod, count] of sortedMods) {
    out.push(`- \`${mod}\` (${count} files)`);
  }

  if (entryPoints.length > 0) {
    out.push('', '## Key Entry Points');
    for (const ep of entryPoints.slice(0, 12)) {
      out.push(`- \`${ep}\``);
    }
  }

  if (topHubs.length > 0) {
    out.push('', '## Core Shared Modules (Most Imported)');
    for (const [file, count] of topHubs) {
      out.push(`- \`${file}\` (${count} dependents)`);
    }
  }

  if (config.boundaries.length > 0) {
    out.push('', '## Enforced Boundaries (`archpilot.json`)');
    for (const b of config.boundaries) {
      out.push(`- \`${b.from}\` ↛ ${b.disallow.map((d) => `\`${d}\``).join(', ')}`);
    }
  }

  out.push('');
  return out.join('\n');
}
