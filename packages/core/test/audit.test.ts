import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeBlastRadius,
  auditRepository,
  buildArchitectureDiagram,
  formatHtmlReport,
  formatMarkdown,
  formatSarif,
  generateArchitectureMd,
  generateArchMap,
  generateMermaidDiagram,
  generateSmartArchPilotConfig,
} from '../src/index.js';

async function createTempRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archpilot-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

test('detects boundary violations and circular dependencies', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# Agents\nRun `npm run test`.\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      scripts: { test: 'echo ok', typecheck: 'tsc --noEmit' },
    }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'archpilot.json': JSON.stringify({
      boundaries: [
        {
          name: 'domain-isolation',
          from: 'src/domain',
          disallow: ['src/ui'],
        },
      ],
    }),
    'src/domain/order.ts': "import { Button } from '../ui/button.js';\nexport const x = Button;\n",
    'src/ui/button.ts': "import { x } from '../domain/order.js';\nexport const Button = x;\n",
    'src/domain/order.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(
      report.findings.some((f) => f.id === 'boundary-violation'),
      'expected boundary-violation finding'
    );
    assert.ok(
      report.findings.some((f) => f.id === 'circular-dependency'),
      'expected circular-dependency finding'
    );
    assert.equal(report.summary.errors, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects stale file paths and dead npm scripts in AGENTS.md', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# Agents\nSee `src/missing.ts` and run `npm run nonexistent`.\n',
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'echo ok' } }),
    'src/index.ts': 'export const ok = true;\n',
    'src/index.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(
      report.findings.some((f) => f.id === 'stale-instruction-path'),
      'expected stale-instruction-path finding'
    );
    assert.ok(
      report.findings.some((f) => f.id === 'stale-instruction-script'),
      'expected stale-instruction-script finding'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('respects .gitignore and caps per-rule penalty', async () => {
  const bigFile = Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  const dir = await createTempRepo({
    '.gitignore': 'generated/\n*.gen.ts\n',
    'AGENTS.md': '# Agents\n',
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'echo ok' } }),
    'generated/huge.ts': bigFile,
    'src/auto.gen.ts': bigFile,
    'src/a.ts': bigFile,
    'src/b.ts': bigFile,
    'src/c.ts': bigFile,
    'src/d.ts': bigFile,
    'src/e.ts': bigFile,
    'src/a.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    const oversized = report.findings.filter((f) => f.id === 'oversized-file');
    assert.equal(oversized.length, 5, 'should ignore generated/ and *.gen.ts');
    const contextCat = report.categories.find((c) => c.id === 'context');
    assert.equal(contextCat?.score, 65, 'per-rule warning penalty should cap at 35');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects Spring Boot REST API guardrails and Java imports', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'target/\n',
    'AGENTS.md': '# Spring API\n',
    'pom.xml': '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    'src/main/java/com/acme/OrderController.java': [
      'package com.acme;',
      'import com.acme.OrderRepository;',
      '@RestController',
      'public class OrderController {',
      '  public void create(@RequestBody OrderDto dto) {}',
      '}',
    ].join('\n'),
    'src/main/java/com/acme/OrderRepository.java': [
      'package com.acme;',
      'public interface OrderRepository {}',
    ].join('\n'),
    'src/test/java/com/acme/OrderControllerTest.java': 'class OrderControllerTest {}\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.detectedStack.languages.includes('java'));
    assert.ok(report.detectedStack.frameworks.includes('Spring Boot'));
    assert.ok(report.detectedStack.capabilities.includes('rest-api'));
    assert.ok(report.findings.some((f) => f.id === 'spring-controller-imports-repository'));
    assert.ok(report.findings.some((f) => f.id === 'spring-missing-valid'));
    assert.ok(report.findings.some((f) => f.id === 'missing-api-contract'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects Python, Go, Rust circular imports and AI/LLM guardrails', async () => {
  const dir = await createTempRepo({
    '.gitignore': '__pycache__/\ntarget/\n',
    'AGENTS.md': '# Polyglot\n',
    'pyproject.toml': '[project]\ndependencies = ["fastapi", "openai"]\n',
    'go.mod': 'module example.com/app\nrequire github.com/gin-gonic/gin v1.10.0\n',
    'Cargo.toml': '[package]\nname = "app"\n[dependencies]\naxum = "0.7"\n',
    'app/a.py': 'from app.b import y\nclient = OpenAI()\n',
    'app/b.py': 'from app.a import client\ny = 1\n',
    'tests/test_a.py': 'def test_ok(): assert True\n',
    'pkg/alpha/a.go': 'package alpha\nimport "example.com/app/pkg/beta"\n',
    'pkg/beta/b.go': 'package beta\nimport "example.com/app/pkg/alpha"\n',
    'src/one.rs': 'use crate::two::val;\n',
    'src/two.rs': 'use crate::one::x;\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.detectedStack.languages.includes('python'));
    assert.ok(report.detectedStack.languages.includes('go'));
    assert.ok(report.detectedStack.languages.includes('rust'));
    assert.ok(report.detectedStack.capabilities.includes('ai-llm'));
    const cycles = report.findings.filter((f) => f.id === 'circular-dependency');
    assert.ok(cycles.length >= 3, `expected cycles in Python, Go, and Rust; got ${cycles.length}`);
    assert.ok(report.findings.some((f) => f.id === 'llm-missing-timeout'));

    const sarif = JSON.parse(formatSarif(report)) as { version: string; runs: Array<{ results: unknown[] }> };
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.runs[0].results.length > 0);

    const md = formatMarkdown(report);
    assert.ok(md.includes('## ArchPilot Report'));
    assert.ok(md.includes('| Category | Score | Findings |'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects token budget bloat, unignored token sinks, and LLM cost traps', async () => {
  const hugeAgents = '# Agents\n' + 'Always follow clean architecture rules.\n'.repeat(350);
  const hugeJson = JSON.stringify(
    Array.from({ length: 1200 }, (_, i) => ({
      id: i,
      description: 'Large unignored fixture payload that wastes AI coding agent context tokens',
    }))
  );
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': hugeAgents,
    'package.json': JSON.stringify({
      name: 'llm-app',
      dependencies: { openai: '^4.0.0' },
      scripts: { test: 'echo ok' },
    }),
    'data/fixtures.json': hugeJson,
    'src/worker.ts': [
      'import OpenAI from "openai";',
      'const client = new OpenAI();',
      'export async function run(items: string[]) {',
      '  for (const item of items) {',
      '    await client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: item }] });',
      '  }',
      '}',
    ].join('\n'),
    'src/worker.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.tokenFootprint.alwaysOnInstructionTokens > 3000);
    assert.ok(report.tokenFootprint.tokenSinks.some((s) => s.file === 'data/fixtures.json'));
    assert.ok(report.findings.some((f) => f.id === 'instruction-token-budget'));
    assert.ok(report.findings.some((f) => f.id === 'token-sink'));
    assert.ok(report.findings.some((f) => f.id === 'llm-missing-max-tokens'));
    assert.ok(report.findings.some((f) => f.id === 'llm-call-in-loop'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects duplicate instruction files and generates compact ARCHMAP.md', async () => {
  const sharedRules = [
    '# Engineering Rules',
    '- Always run unit tests before opening a pull request.',
    '- Follow strict module boundaries between domain and UI layers.',
    '- Never commit API keys or credentials to source control.',
    '- Keep TypeScript strict mode enabled across all packages.',
    '- Document all public REST endpoints in OpenAPI YAML.',
  ].join('\n');

  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': sharedRules,
    'CLAUDE.md': sharedRules,
    'package.json': JSON.stringify({ name: 'dup-test', scripts: { test: 'echo ok' } }),
    'src/index.ts': "import { helper } from './core/helper.js';\nexport const run = helper;\n",
    'src/core/helper.ts': 'export const helper = () => 1;\n',
    'src/core/helper.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'duplicate-instructions'));

    const archMap = await generateArchMap(dir);
    assert.ok(archMap.includes('# ARCHMAP.md'));
    assert.ok(archMap.includes('src/index.ts'));
    assert.ok(archMap.includes('src/core/helper.ts'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto-generates tailored boundary rules from real repository folders', async () => {
  const dir = await createTempRepo({
    'src/domain/order.ts': 'export interface Order { id: string; }\n',
    'src/ui/OrderCard.tsx': 'export const OrderCard = () => null;\n',
    'src/db/orderRepo.ts': 'export const save = () => {};\n',
    'src/shared/date.ts': 'export const now = () => Date.now();\n',
  });

  try {
    const raw = await generateSmartArchPilotConfig(dir);
    const parsed = JSON.parse(raw) as { boundaries: Array<{ name: string; from: string; disallow: string[] }> };
    assert.ok(
      parsed.boundaries.some((b) => b.from === 'src/domain' && b.disallow.includes('src/ui')),
      'expected domain-isolation rule'
    );
    assert.ok(
      parsed.boundaries.some((b) => b.from === 'src/ui' && b.disallow.includes('src/db')),
      'expected ui-no-direct-db rule'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computes direct and transitive blast radius for changed files', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# Agents\n',
    'package.json': JSON.stringify({ name: 'br-test', scripts: { test: 'echo ok' } }),
    'src/core/types.ts': 'export type Id = string;\n',
    'src/service/user.ts': "import type { Id } from '../core/types.js';\nexport const getUser = (id: Id) => id;\n",
    'src/ui/profile.ts': "import { getUser } from '../service/user.js';\nexport const Profile = () => getUser('1');\n",
    'src/service/user.test.ts': 'export {};\n',
  });

  try {
    const br = await analyzeBlastRadius(dir, ['src/core/types.ts']);
    assert.deepEqual(br.directDependents, ['src/service/user.ts']);
    assert.deepEqual(br.transitiveDependents, ['src/service/user.ts', 'src/ui/profile.ts']);
    assert.equal(br.riskLevel, 'low');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects security vulnerabilities, exposed .env, secrets, and poisoned instructions', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    '.env': 'DB_PASS=supersecret\n',
    'AGENTS.md': '# Agents\nRun \u200Bhidden instruction\n',
    'package.json': JSON.stringify({ name: 'sec-test', scripts: { test: 'echo ok' } }),
    'src/api.ts': [
      'const aws = "AKIAIOSFODNN7EXAMPLE1";',
      'export async function find(db: any, id: string) {',
      '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
      '}',
      'const agentOpts = { rejectUnauthorized: false };',
      'export function runCmd(arg: string) { exec(`ls ${arg}`); }',
    ].join('\n'),
    'src/api.test.ts': 'export {};\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'exposed-secret-file'));
    assert.ok(report.findings.some((f) => f.id === 'poisoned-agent-instructions'));
    assert.ok(report.findings.some((f) => f.id === 'sql-injection-risk'));
    assert.ok(report.findings.some((f) => f.id === 'insecure-tls'));
    assert.ok(report.findings.some((f) => f.id === 'command-injection-risk'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects dependency drift, unpinned deps, Next.js client->server leaks, and FastAPI sync-in-async', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# App\n',
    'package.json': JSON.stringify({
      name: 'monorepo',
      dependencies: { next: '^15.0.0', react: '^18.2.0', lodash: 'latest' },
      scripts: { test: 'echo ok' },
    }),
    'packages/web/package.json': JSON.stringify({
      name: 'web',
      dependencies: { react: '^19.0.0' },
    }),
    'packages/web/Button.tsx': "'use client';\nimport fs from 'node:fs';\nexport const B = () => fs;\n",
    'pyproject.toml': '[project]\ndependencies = ["fastapi"]\n',
    'api/routes.py': 'async def get_items():\n    return requests.get("https://example.com")\n',
    'api/test_routes.py': 'def test_ok(): assert True\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'unpinned-dependency'));
    assert.ok(report.findings.some((f) => f.id === 'dependency-version-conflict'));
    assert.ok(report.findings.some((f) => f.id === 'client-imports-server'));
    assert.ok(report.findings.some((f) => f.id === 'fastapi-sync-in-async'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects QA flaky tests, untested blast radius, and renders executive HTML report', async () => {
  const sleepCall = 'await page.waitFor' + 'Timeout(3000);';
  const skippedDecl = 'test.' + 'skip("old test", () => {});';
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# QA\n',
    'package.json': JSON.stringify({ name: 'qa-app', scripts: { test: 'echo ok' } }),
    'src/payment.ts': 'export const charge = () => true;\n',
    'src/checkout.ts': "import { charge } from './payment.js';\nexport const run = () => charge();\n",
    'src/payment.test.ts': [
      'test("flaky", async () => {',
      `  ${sleepCall}`,
      '});',
      skippedDecl,
    ].join('\n'),
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'flaky-test-sleep'));
    assert.ok(report.findings.some((f) => f.id === 'skipped-test'));
    assert.ok(report.findings.some((f) => f.id === 'test-missing-assertions'));

    const br = await analyzeBlastRadius(dir, ['src/payment.ts']);
    assert.deepEqual(br.impactedTestsToRun, ['src/payment.test.ts']);
    assert.deepEqual(br.untestedImpactedFiles, ['src/checkout.ts']);

    const html = formatHtmlReport(report);
    assert.ok(html.includes('ArchPilot Executive Audit Report'));
    assert.ok(html.includes('Category Scorecard'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects NFR resilience & performance issues (HTTP timeouts, swallowed errors, sync I/O, missing health)', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'AGENTS.md': '# API\n',
    'package.json': JSON.stringify({
      name: 'express-api',
      dependencies: { express: '^4.21.0' },
      scripts: { test: 'echo ok' },
    }),
    'src/server.ts': [
      'import fs from "node:fs";',
      'export async function handler() {',
      '  try {',
      '    const data = fs.readFileSync("config.json", "utf8");',
      '    await fetch("https://api.example.com/orders");',
      '    return data;',
      '  } catch (e) {}',
      '}',
    ].join('\n'),
    'src/server.test.ts': 'test("ok", () => { assert.ok(true); });\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'http-missing-timeout'));
    assert.ok(report.findings.some((f) => f.id === 'swallowed-error'));
    assert.ok(report.findings.some((f) => f.id === 'sync-io-in-api'));
    assert.ok(report.findings.some((f) => f.id === 'missing-health-endpoint'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects Spectral-style OpenAPI issues, REST URI verbs, and Spring Boot NFRs', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'target/\n',
    'AGENTS.md': '# Orders API\n',
    'pom.xml': '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    'openapi.yaml': [
      'openapi: 3.0.3',
      'info:',
      '  title: Orders API',
      '  version: 1.0.0',
      'paths:',
      '  /getOrders:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '  /userProfiles/{id}:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
    ].join('\n'),
    'src/main/java/com/acme/OrderController.java': [
      'package com.acme;',
      '@RestController',
      'public class OrderController {',
      '  @Autowired',
      '  private OrderService orderService;',
      '  private final RestTemplate client = new RestTemplate();',
      '  @GetMapping("/getOrders")',
      '  public Object all() { return orderService.findAll(); }',
      '}',
    ].join('\n'),
    'src/test/java/com/acme/OrderControllerTest.java': 'class OrderControllerTest { @Test void ok() { assertTrue(true); } }\n',
  });

  try {
    const report = await auditRepository(dir);
    assert.ok(report.findings.some((f) => f.id === 'oas-missing-info-description'));
    assert.ok(report.findings.some((f) => f.id === 'oas-missing-servers'));
    assert.ok(report.findings.some((f) => f.id === 'oas-missing-security'));
    assert.ok(report.findings.some((f) => f.id === 'oas-missing-operation-id'));
    assert.ok(report.findings.some((f) => f.id === 'oas-missing-error-responses'));
    assert.ok(report.findings.some((f) => f.id === 'rest-uri-verb'));
    assert.ok(report.findings.some((f) => f.id === 'rest-uri-naming'));
    assert.ok(report.findings.some((f) => f.id === 'rest-route-verb'));
    assert.ok(report.findings.some((f) => f.id === 'spring-resttemplate-no-timeout'));
    assert.ok(report.findings.some((f) => f.id === 'spring-unbounded-findall'));
    assert.ok(report.findings.some((f) => f.id === 'spring-field-autowired'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generates living architecture diagram with external systems and valid Mermaid/ARCHITECTURE.md', async () => {
  const dir = await createTempRepo({
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify({ name: 'sys-app', dependencies: { openai: '^4.0.0', pg: '^8.0.0' } }),
    'src/api/orders.ts': "import { saveOrder } from '../db/orders.js';\nimport OpenAI from 'openai';\nexport const run = () => [saveOrder, OpenAI];\n",
    'src/db/orders.ts': "import { Pool } from 'pg';\nexport const saveOrder = () => new Pool();\n",
  });

  try {
    const diagram = await buildArchitectureDiagram(dir);
    assert.ok(diagram.externalSystems.some((e) => e.label === 'PostgreSQL'));
    assert.ok(diagram.externalSystems.some((e) => e.label === 'OpenAI API'));

    const mermaid = generateMermaidDiagram(diagram);
    assert.ok(mermaid.startsWith('flowchart LR'));
    assert.ok(mermaid.includes('ext_postgres'));
    assert.ok(mermaid.includes('ext_openai'));

    const archMd = await generateArchitectureMd(dir);
    assert.ok(archMd.includes('# ARCHITECTURE.md'));
    assert.ok(archMd.includes('```mermaid'));
    assert.ok(archMd.includes('External Integrations'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
