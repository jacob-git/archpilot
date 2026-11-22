import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compareAgainstBaseline,
  findOrphanFiles,
  saveArchitectureBaseline,
} from '../src/index.js';

async function withTempRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archpilot-v090-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('findOrphanFiles detects unreachable helpers while skipping entrypoints, tests, and Spring controllers', async () => {
  await withTempRepo(
    {
      'package.json': JSON.stringify({ name: 'orphan-demo', main: 'src/index.ts' }),
      'src/index.ts': 'import { used } from "./used";\nconsole.log(used());\n',
      'src/used.ts': 'export const used = () => 42;\n',
      'src/deadHelper.ts': 'export const unused = () => "never imported anywhere";\n',
      'src/deadHelper.test.ts': 'console.log("test file should be skipped");\n',
      'src/main/java/com/acme/UserController.java':
        '@RestController\npublic class UserController {}\n',
    },
    async (dir) => {
      const res = await findOrphanFiles(dir);
      const orphanPaths = res.orphans.map((o) => o.file);
      assert.deepEqual(orphanPaths, ['src/deadHelper.ts']);
      assert.ok(res.totalWastedTokens > 0);
    }
  );
});

test('baseline snapshot detects newly introduced regressions and resolved issues', async () => {
  await withTempRepo(
    {
      'AGENTS.md': '# Guide\nRun `npm test`.\n',
      'package.json': JSON.stringify({ name: 'baseline-demo', scripts: { test: 'echo ok' } }),
      'archpilot.json': JSON.stringify({ boundaries: [], ignore: ['node_modules'] }),
      '.gitignore': 'node_modules\n',
      'src/app.ts': 'export const ok = true;\n',
    },
    async (dir) => {
      const missing = await compareAgainstBaseline(dir);
      assert.equal(missing.hasBaseline, false);

      const { baseline } = await saveArchitectureBaseline(dir);
      assert.ok(baseline.overallScore >= 80);

      // Introduce a security regression (eval)
      await writeFile(
        path.join(dir, 'src/app.ts'),
        'export const bad = (x: string) => eval(x);\n',
        'utf8'
      );

      const regressed = await compareAgainstBaseline(dir);
      assert.equal(regressed.hasBaseline, true);
      assert.equal(regressed.status, 'regressed');
      assert.ok(regressed.newFindings.some((f) => f.id === 'unsafe-code-exec'));
      assert.ok(regressed.scoreDelta < 0);

      // Revert the regression and verify clean diff
      await writeFile(path.join(dir, 'src/app.ts'), 'export const ok = true;\n', 'utf8');
      const clean = await compareAgainstBaseline(dir);
      assert.equal(clean.status, 'unchanged');
      assert.equal(clean.newFindings.length, 0);
    }
  );
});
