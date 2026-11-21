import { readFile } from 'node:fs/promises';
import type { CheckContext, Finding } from '../types.js';
import { CODE_EXTENSIONS } from '../scanner.js';

export async function runContextBloatCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const codeFiles = ctx.files.filter((f) => CODE_EXTENSIONS.has(f.ext));

  // 1. Flag mega-files that degrade agent edit accuracy and context efficiency
  await Promise.all(
    codeFiles.map(async (file) => {
      // Quick byte heuristic before reading: skip tiny files
      if (file.sizeBytes < 8_000) {
        return;
      }
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }
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
    })
  );

  // 2. Check for .gitignore
  if (!ctx.fileSet.has('.gitignore')) {
    findings.push({
      id: 'missing-gitignore',
      category: 'context',
      severity: 'warning',
      message: 'No .gitignore found; build outputs and dependencies can pollute agent search.',
      suggestion: 'Add a .gitignore excluding build artifacts, dependencies, and caches.',
    });
  }

  return findings;
}
