import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckContext, Finding } from '../types.js';

const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|tests?\/|.*\.(?:test|spec)\.[a-z0-9]+|test_.*\.py|.*_test\.go)$/i;

export async function runVerifiabilityCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. Check for test files
  const hasTests = ctx.files.some((f) => TEST_FILE_RE.test(f.relPath));
  if (!hasTests) {
    findings.push({
      id: 'missing-tests',
      category: 'verifiability',
      severity: 'warning',
      message: 'No automated test files detected. AI agents need fast tests to self-verify edits.',
      suggestion: 'Add unit tests covering core business logic and module contracts.',
    });
  }

  // 2. Check package.json scripts if Node/TS project
  if (ctx.packageJson) {
    const scripts =
      typeof ctx.packageJson.scripts === 'object' && ctx.packageJson.scripts !== null
        ? (ctx.packageJson.scripts as Record<string, unknown>)
        : {};

    const testScript = typeof scripts.test === 'string' ? scripts.test : '';
    if (!testScript || testScript.includes('no test specified')) {
      findings.push({
        id: 'missing-test-script',
        category: 'verifiability',
        severity: 'warning',
        file: 'package.json',
        line: 1,
        message: 'No runnable `test` script found in package.json.',
        suggestion: 'Add a fast `test` script so coding agents and CI can validate changes automatically.',
      });
    }

    const hasTypecheckOrLint =
      typeof scripts.typecheck === 'string' ||
      typeof scripts.lint === 'string' ||
      typeof scripts.check === 'string' ||
      typeof scripts.build === 'string';

    if (!hasTypecheckOrLint) {
      findings.push({
        id: 'missing-verify-script',
        category: 'verifiability',
        severity: 'info',
        file: 'package.json',
        line: 1,
        message: 'No `typecheck`, `lint`, or `build` script found in package.json.',
        suggestion: 'Add a `typecheck` or `lint` script for fast deterministic agent feedback.',
      });
    }
  }

  // 3. If TypeScript is used, check `strict: true`
  const tsConfigs = ctx.files.filter(
    (f) => f.relPath === 'tsconfig.json' || f.relPath === 'tsconfig.base.json'
  );
  if (tsConfigs.length > 0) {
    let strictEnabled = false;
    for (const tsFile of tsConfigs) {
      try {
        const raw = await readFile(path.join(ctx.rootDir, tsFile.relPath), 'utf8');
        if (/"strict"\s*:\s*true/.test(raw)) {
          strictEnabled = true;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!strictEnabled) {
      findings.push({
        id: 'ts-strict-disabled',
        category: 'verifiability',
        severity: 'warning',
        file: tsConfigs[0].relPath,
        line: 1,
        message: 'TypeScript `strict: true` is not enabled.',
        suggestion: 'Enable `"strict": true` in tsconfig so agents catch null/type bugs at compile time.',
      });
    }
  }

  return findings;
}
