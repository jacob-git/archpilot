import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditRepository } from './audit.js';
import { buildArchitectureDiagram } from './diagrams.js';
import type { Finding } from './types.js';

export const BASELINE_FILENAME = '.archpilot-baseline.json';

export interface ArchitectureBaseline {
  version: 1;
  createdAt: string;
  overallScore: number;
  grade: string;
  categoryScores: Record<string, number>;
  findingSignatures: string[];
  findingSummary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  moduleCount: number;
  edgeCount: number;
  externalSystems: string[];
  alwaysOnTokens: number;
  sinkTokens: number;
}

export interface BaselineDiffReport {
  hasBaseline: boolean;
  baselinePath: string;
  baselineCreatedAt?: string;
  status: 'improved' | 'unchanged' | 'regressed';
  baselineScore: number;
  currentScore: number;
  scoreDelta: number;
  tokenDelta: number;
  newFindings: Finding[];
  resolvedSignatures: string[];
  newExternalSystems: string[];
  removedExternalSystems: string[];
}

function findingSignature(f: Finding): string {
  return `${f.id}::${f.file ?? ''}::${f.message}`;
}

export async function createArchitectureBaseline(rootDir: string): Promise<ArchitectureBaseline> {
  const [report, diagram] = await Promise.all([
    auditRepository(rootDir),
    buildArchitectureDiagram(rootDir),
  ]);

  const categoryScores: Record<string, number> = {};
  for (const cat of report.categories) {
    categoryScores[cat.id] = cat.score;
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    overallScore: report.overallScore,
    grade: report.grade,
    categoryScores,
    findingSignatures: Array.from(new Set(report.findings.map(findingSignature))).sort(),
    findingSummary: {
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      infos: report.summary.infos,
    },
    moduleCount: diagram.graph.nodes.length,
    edgeCount: diagram.graph.edges.length,
    externalSystems: diagram.externalSystems.map((s) => s.label).sort(),
    alwaysOnTokens: report.tokenFootprint.alwaysOnInstructionTokens,
    sinkTokens: report.tokenFootprint.totalSinkTokens,
  };
}

export async function saveArchitectureBaseline(rootDir: string): Promise<{
  baselinePath: string;
  baseline: ArchitectureBaseline;
}> {
  const baseline = await createArchitectureBaseline(rootDir);
  const baselinePath = path.join(rootDir, BASELINE_FILENAME);
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return { baselinePath, baseline };
}

export async function compareAgainstBaseline(rootDir: string): Promise<BaselineDiffReport> {
  const baselinePath = path.join(rootDir, BASELINE_FILENAME);
  let baseline: ArchitectureBaseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as ArchitectureBaseline;
  } catch {
    return {
      hasBaseline: false,
      baselinePath,
      status: 'unchanged',
      baselineScore: 0,
      currentScore: 0,
      scoreDelta: 0,
      tokenDelta: 0,
      newFindings: [],
      resolvedSignatures: [],
      newExternalSystems: [],
      removedExternalSystems: [],
    };
  }

  const [report, diagram] = await Promise.all([
    auditRepository(rootDir),
    buildArchitectureDiagram(rootDir),
  ]);

  const baselineSigSet = new Set(baseline.findingSignatures ?? []);
  const currentSigSet = new Set(report.findings.map(findingSignature));

  const newFindings = report.findings.filter((f) => !baselineSigSet.has(findingSignature(f)));
  const resolvedSignatures = (baseline.findingSignatures ?? []).filter(
    (sig) => !currentSigSet.has(sig)
  );

  const baselineExtSet = new Set(baseline.externalSystems ?? []);
  const currentExtLabels = diagram.externalSystems.map((s) => s.label).sort();
  const currentExtSet = new Set(currentExtLabels);

  const newExternalSystems = currentExtLabels.filter((l) => !baselineExtSet.has(l));
  const removedExternalSystems = (baseline.externalSystems ?? []).filter(
    (l) => !currentExtSet.has(l)
  );

  const scoreDelta = report.overallScore - baseline.overallScore;
  const baselineTotalTokens = (baseline.alwaysOnTokens ?? 0) + (baseline.sinkTokens ?? 0);
  const currentTotalTokens =
    report.tokenFootprint.alwaysOnInstructionTokens + report.tokenFootprint.totalSinkTokens;
  const tokenDelta = currentTotalTokens - baselineTotalTokens;

  let status: BaselineDiffReport['status'] = 'unchanged';
  if (newFindings.length > 0 || scoreDelta < 0) {
    status = 'regressed';
  } else if (resolvedSignatures.length > 0 || scoreDelta > 0) {
    status = 'improved';
  }

  return {
    hasBaseline: true,
    baselinePath,
    baselineCreatedAt: baseline.createdAt,
    status,
    baselineScore: baseline.overallScore,
    currentScore: report.overallScore,
    scoreDelta,
    tokenDelta,
    newFindings,
    resolvedSignatures,
    newExternalSystems,
    removedExternalSystems,
  };
}
