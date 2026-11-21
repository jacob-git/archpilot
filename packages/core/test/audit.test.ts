import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditRepository, formatMarkdown, formatSarif } from '../src/index.js';

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
