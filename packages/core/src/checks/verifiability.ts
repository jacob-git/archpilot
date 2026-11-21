import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckContext, Finding } from '../types.js';

const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|tests?\/|.*\.(?:test|spec|cy)\.[a-z0-9]+|test_.*\.py|.*_test\.go|.*Test\.java)$/i;

export async function runVerifiabilityCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. Check for test files & QA flaky-test anti-patterns
  const testFiles = ctx.files.filter((f) => TEST_FILE_RE.test(f.relPath));
  if (testFiles.length === 0) {
    findings.push({
      id: 'missing-tests',
      category: 'verifiability',
      severity: 'warning',
      message: 'No automated test files detected. AI agents need fast tests to self-verify edits.',
      suggestion: 'Add unit tests covering core business logic and module contracts.',
    });
  } else {
    await Promise.all(
      testFiles.slice(0, 60).map(async (tf) => {
        if (tf.sizeBytes > 250_000) return;
        let content: string;
        try {
          content = await readFile(tf.absPath, 'utf8');
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);
        let hasTestDecl = false;
        let hasAssertion = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
            continue;
          }

          if (/\b(?:test|it)\s*\(|\bdef\s+test_|@Test\b|\bfunc\s+Test/.test(line)) {
            hasTestDecl = true;
          }
          if (/\b(?:expect|assert|should|verify|t\.(?:Error|Fatal|Fail)|assertEquals|assertTrue|assertThat)\b/i.test(line)) {
            hasAssertion = true;
          }

          if (
            /\bwaitForTimeout\s*\(|\bcy\.wait\s*\(\s*\d+|\btime\.sleep\s*\(|\bThread\.sleep\s*\(/.test(
              line
            )
          ) {
            findings.push({
              id: 'flaky-test-sleep',
              category: 'verifiability',
              severity: 'warning',
              file: tf.relPath,
              line: i + 1,
              message: 'Hardcoded sleep/timeout wait detected in test: common source of flaky CI.',
              suggestion: 'Replace fixed sleeps with deterministic condition/locator waits or fake timers.',
            });
          }

          if (
            /\b(?:it|test|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@Disabled\b|@Ignore\b|@pytest\.mark\.skip\b/.test(
              line
            )
          ) {
            findings.push({
              id: 'skipped-test',
              category: 'verifiability',
              severity: 'info',
              file: tf.relPath,
              line: i + 1,
              message: 'Skipped or `.only` test left in test suite.',
              suggestion: 'Re-enable, fix, or remove skipped/`.only` tests so CI coverage stays reliable.',
            });
          }
        }

        if (hasTestDecl && !hasAssertion) {
          findings.push({
            id: 'test-missing-assertions',
            category: 'verifiability',
            severity: 'warning',
            file: tf.relPath,
            line: 1,
            message: 'Test file declares tests without any visible assertions (`expect` / `assert`).',
            suggestion: 'Add explicit assertions so regressions fail the test suite instead of passing silently.',
          });
        }
      })
    );
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
