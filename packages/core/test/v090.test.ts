import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeTokenBreakdown,
  compareAgainstBaseline,
  diffOpenApiSpecs,
  findOrphanFiles,
  findUnusedDependencies,
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

test('analyzeTokenBreakdown ranks heaviest folders and files accurately', async () => {
  await withTempRepo(
    {
      'src/small.ts': 'export const x = 1;\n',
      'data/generated/huge.json': JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) }),
    },
    async (dir) => {
      const res = await analyzeTokenBreakdown(dir, 3);
      assert.equal(res.topFolders[0].folder, 'data/generated');
      assert.equal(res.topFiles[0].file, 'data/generated/huge.json');
      assert.ok(res.totalTokens > 200);
      assert.ok(res.fullReadCostUsd > 0);
    }
  );
});

test('findUnusedDependencies flags unimported package.json dependencies while keeping imported and script-referenced ones', async () => {
  await withTempRepo(
    {
      'package.json': JSON.stringify({
        name: 'deps-demo',
        scripts: { start: 'tsx src/index.ts' },
        dependencies: {
          zod: '^3.22.0',
          lodash: '^4.17.21',
          tsx: '^4.0.0',
        },
      }),
      'src/index.ts': 'import { z } from "zod";\nexport const s = z.string();\n',
    },
    async (dir) => {
      const res = await findUnusedDependencies(dir);
      assert.equal(res.totalDependencies, 3);
      assert.deepEqual(
        res.unused.map((u) => u.name),
        ['lodash']
      );
    }
  );
});

test('diffOpenApiSpecs catches removed paths, methods, 2xx responses, removed properties, and new required fields in YAML', () => {
  const oldYaml = `
openapi: 3.0.3
paths:
  /v1/orders:
    get:
      responses:
        '200':
          description: ok
    delete:
      responses:
        '204':
          description: deleted
  /v1/legacy:
    get:
      responses:
        '200':
          description: ok
components:
  schemas:
    OrderRequest:
      required:
        - itemId
      properties:
        itemId:
          type: string
        note:
          type: string
`;

  const newYaml = `
openapi: 3.0.3
paths:
  /v1/orders:
    get:
      responses:
        '201':
          description: created
  /v1/health:
    get:
      responses:
        '200':
          description: healthy
components:
  schemas:
    OrderRequest:
      required:
        - itemId
        - currency
      properties:
        itemId:
          type: string
        currency:
          type: string
`;

  const res = diffOpenApiSpecs(oldYaml, newYaml, 'openapi.yaml');
  const ruleIds = new Set(res.breakingChanges.map((b) => b.ruleId));
  assert.ok(ruleIds.has('openapi-path-removed'), 'Expected removed /v1/legacy path');
  assert.ok(ruleIds.has('openapi-method-removed'), 'Expected removed DELETE /v1/orders');
  assert.ok(ruleIds.has('openapi-success-response-removed'), 'Expected removed 200 response');
  assert.ok(ruleIds.has('openapi-schema-property-removed'), 'Expected removed note property');
  assert.ok(ruleIds.has('openapi-schema-required-added'), 'Expected added required currency field');
  assert.deepEqual(res.addedEndpoints, ['GET /v1/health']);
});
