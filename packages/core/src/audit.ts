import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditOptions,
  AuditReport,
  CategoryId,
  CategoryScore,
  CheckContext,
  Finding,
} from './types.js';
import { loadConfig } from './config.js';
import { CODE_EXTENSIONS, scanWorkspace } from './scanner.js';
import { detectStack } from './stack.js';
import { runInstructionsCheck } from './checks/instructions.js';
import { runBoundariesCheck } from './checks/boundaries.js';
import { runContextBloatCheck } from './checks/contextBloat.js';
import { runVerifiabilityCheck } from './checks/verifiability.js';
import { runStackPacksCheck } from './checks/stackPacks.js';
import { checkCustomMigrations } from './migrations.js';
import { runSecurityCheck } from './checks/security.js';

const CATEGORY_META: Array<{ id: CategoryId; label: string; weight: number }> = [
  { id: 'instructions', label: 'Agent Instructions', weight: 0.15 },
  { id: 'architecture', label: 'Architecture & Boundaries', weight: 0.25 },
  { id: 'security', label: 'Security Guardrails', weight: 0.2 },
  { id: 'stack', label: 'Stack & API Guardrails', weight: 0.15 },
  { id: 'context', label: 'Context Hygiene', weight: 0.1 },
  { id: 'verifiability', label: 'Verifiability & Contracts', weight: 0.15 },
];

function scoreFindings(findings: Finding[]): number {
  const penaltyByRule = new Map<string, number>();
  const capBySeverity = {
    error: 60,
    warning: 35,
    info: 12,
  } as const;
  const weightBySeverity = {
    error: 25,
    warning: 10,
    info: 4,
  } as const;

  for (const f of findings) {
    const current = penaltyByRule.get(f.id) ?? 0;
    const cap = capBySeverity[f.severity];
    const next = Math.min(cap, current + weightBySeverity[f.severity]);
    penaltyByRule.set(f.id, next);
  }

  let totalPenalty = 0;
  for (const p of penaltyByRule.values()) {
    totalPenalty += p;
  }
  return Math.max(0, Math.min(100, 100 - totalPenalty));
}

function toGrade(score: number): AuditReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export async function auditRepository(
  rootDir: string,
  options?: AuditOptions
): Promise<AuditReport> {
  const start = Date.now();
  const resolvedRoot = path.resolve(rootDir);
  const { config, hasConfigFile } = await loadConfig(resolvedRoot);
  const files = await scanWorkspace(resolvedRoot, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));

  let packageJson: Record<string, unknown> | undefined;
  if (fileSet.has('package.json')) {
    try {
      const raw = await readFile(path.join(resolvedRoot, 'package.json'), 'utf8');
      packageJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignore invalid package.json
    }
  }

  const detectedStack = await detectStack(resolvedRoot, files, fileSet, packageJson);

  const ctx: CheckContext = {
    rootDir: resolvedRoot,
    config,
    files,
    fileSet,
    packageJson,
    detectedStack,
  };

  const [
    instructionFindings,
    boundaryFindings,
    securityFindings,
    stackFindings,
    migrationFindings,
    contextResult,
    verifyFindings,
  ] = await Promise.all([
    runInstructionsCheck(ctx),
    runBoundariesCheck(ctx, hasConfigFile),
    runSecurityCheck(ctx),
    runStackPacksCheck(ctx),
    checkCustomMigrations(ctx),
    runContextBloatCheck(ctx, options),
    runVerifiabilityCheck(ctx),
  ]);

  const byCategory: Record<CategoryId, Finding[]> = {
    instructions: instructionFindings,
    architecture: boundaryFindings,
    security: securityFindings,
    stack: [...stackFindings, ...migrationFindings],
    context: contextResult.findings,
    verifiability: verifyFindings,
  };

  const categories: CategoryScore[] = CATEGORY_META.map((meta) => {
    const catFindings = byCategory[meta.id];
    return {
      id: meta.id,
      label: meta.label,
      weight: meta.weight,
      score: scoreFindings(catFindings),
      findings: catFindings,
    };
  });

  const overallScore = Math.round(
    categories.reduce((acc, c) => acc + c.score * c.weight, 0)
  );
  const findings = categories.flatMap((c) => c.findings);

  return {
    rootDir: resolvedRoot,
    overallScore,
    grade: toGrade(overallScore),
    detectedStack,
    tokenFootprint: contextResult.tokenFootprint,
    categories,
    findings,
    summary: {
      filesScanned: files.length,
      codeFiles: files.filter((f) => CODE_EXTENSIONS.has(f.ext)).length,
      durationMs: Date.now() - start,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      infos: findings.filter((f) => f.severity === 'info').length,
    },
  };
}
