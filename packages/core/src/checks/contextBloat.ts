import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditOptions,
  CheckContext,
  Finding,
  TokenFootprint,
  TokenSink,
} from '../types.js';
import { CODE_EXTENSIONS } from '../scanner.js';

const INSTRUCTION_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
]);

const TEXT_SINK_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  '.json',
  '.csv',
  '.sql',
  '.xml',
  '.svg',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
]);

const STANDARD_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);

function isInstructionPath(relPath: string): boolean {
  if (INSTRUCTION_FILES.has(relPath)) return true;
  return (
    relPath.startsWith('.cursor/rules/') &&
    (relPath.endsWith('.mdc') || relPath.endsWith('.md'))
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function runContextBloatCheck(
  ctx: CheckContext,
  options?: AuditOptions
): Promise<{
  findings: Finding[];
  tokenFootprint: TokenFootprint;
}> {
  const findings: Finding[] = [];
  const tokenSinks: TokenSink[] = [];
  let alwaysOnInstructionTokens = 0;

  // 1. Always-on instruction token budget
  const instructionFiles = ctx.files.filter((f) => isInstructionPath(f.relPath));
  for (const file of instructionFiles) {
    try {
      const content = await readFile(file.absPath, 'utf8');
      alwaysOnInstructionTokens += estimateTokens(content);
    } catch {
      // ignore read errors
    }
  }

  if (alwaysOnInstructionTokens > ctx.config.maxInstructionTokens) {
    findings.push({
      id: 'instruction-token-budget',
      category: 'context',
      severity: 'warning',
      file: instructionFiles[0]?.relPath,
      line: 1,
      message: `Always-on agent instructions consume ~${alwaysOnInstructionTokens.toLocaleString('en-US')} tokens/turn (budget: ${ctx.config.maxInstructionTokens.toLocaleString('en-US')}).`,
      suggestion:
        'Trim redundant rules or move domain-specific guidance into on-demand docs to cut per-turn LLM token costs.',
    });
  }

  // 2. Flag oversized code files & unignored token-sink files
  const minSinkBytes = ctx.config.maxFileTokens * 3; // conservative byte threshold before reading
  await Promise.all(
    ctx.files.map(async (file) => {
      const isCode = CODE_EXTENSIONS.has(file.ext);
      const isTextSinkCandidate =
        TEXT_SINK_EXTENSIONS.has(file.ext) &&
        !STANDARD_LOCKFILES.has(path.posix.basename(file.relPath));

      if (!isCode && !isTextSinkCandidate) return;
      if (file.sizeBytes < 8_000) return;

      // Avoid reading huge >2MB files into memory; estimate directly from byte size
      if (file.sizeBytes > 2_000_000) {
        const estTokens = Math.ceil(file.sizeBytes / 4);
        if (isTextSinkCandidate && estTokens > ctx.config.maxFileTokens) {
          tokenSinks.push({ file: file.relPath, estimatedTokens: estTokens });
        }
        return;
      }

      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }

      if (isCode) {
        const lineCount = content.split(/\r?\n/).length;
        if (lineCount > ctx.config.maxFileLines) {
          findings.push({
            id: 'oversized-file',
            category: 'context',
            severity: 'warning',
            file: file.relPath,
            line: 1,
            message: `Oversized file (${lineCount.toLocaleString('en-US')} lines; limit ${ctx.config.maxFileLines}).`,
            suggestion: 'Split cohesive responsibilities into smaller, well-named modules.',
          });
        }
      }

      if (isTextSinkCandidate && file.sizeBytes >= minSinkBytes) {
        const estTokens = estimateTokens(content);
        if (estTokens > ctx.config.maxFileTokens) {
          tokenSinks.push({ file: file.relPath, estimatedTokens: estTokens });
        }
      }
    })
  );

  // Sort token sinks largest-first and surface top 10
  tokenSinks.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const totalSinkTokens = tokenSinks.reduce((acc, s) => acc + s.estimatedTokens, 0);

  for (const sink of tokenSinks.slice(0, 10)) {
    findings.push({
      id: 'token-sink',
      category: 'context',
      severity: sink.estimatedTokens >= ctx.config.maxFileTokens * 2 ? 'warning' : 'info',
      file: sink.file,
      line: 1,
      message: `Unignored token sink (~${sink.estimatedTokens.toLocaleString('en-US')} tokens; limit ${ctx.config.maxFileTokens.toLocaleString('en-US')}).`,
      suggestion: 'Add to .aiignore / .cursorignore or split so coding agents stop burning context tokens on it.',
    });
  }

  // 3. Check for .gitignore
  if (!ctx.fileSet.has('.gitignore')) {
    findings.push({
      id: 'missing-gitignore',
      category: 'context',
      severity: 'warning',
      message: 'No .gitignore found; build outputs and dependencies can pollute agent search.',
      suggestion: 'Add a .gitignore excluding build artifacts, dependencies, and caches.',
    });
  }

  const inputPerMillionUsd = options?.inputPerMillionUsd ?? 3;
  const turnsPerMonth = options?.turnsPerMonth ?? 2200;
  const modelLabel = options?.modelLabel ?? `Standard ($${inputPerMillionUsd}/1M)`;
  const sinkReadsPerMonth = 110; // ~5 agent file reads/day x 22 workdays

  const alwaysOnMonthlyUsd = Number(
    ((alwaysOnInstructionTokens * turnsPerMonth * inputPerMillionUsd) / 1_000_000).toFixed(2)
  );
  const sinkMonthlyRiskUsd = Number(
    ((totalSinkTokens * sinkReadsPerMonth * inputPerMillionUsd) / 1_000_000).toFixed(2)
  );
  const excessInstructionTokens = Math.max(
    0,
    alwaysOnInstructionTokens - ctx.config.maxInstructionTokens
  );
  const excessInstructionUsd =
    (excessInstructionTokens * turnsPerMonth * inputPerMillionUsd) / 1_000_000;
  const potentialMonthlySavingsUsd = Number(
    (sinkMonthlyRiskUsd + excessInstructionUsd).toFixed(2)
  );

  return {
    findings,
    tokenFootprint: {
      alwaysOnInstructionTokens,
      tokenSinks: tokenSinks.slice(0, 10),
      totalSinkTokens,
      costEstimate: {
        modelLabel,
        inputPerMillionUsd,
        turnsPerMonth,
        alwaysOnMonthlyUsd,
        sinkMonthlyRiskUsd,
        potentialMonthlySavingsUsd,
      },
    },
  };
}
