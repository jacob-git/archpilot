import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findUnusedDependencies,
  parseGoVulnCheckJson,
  parseOsvScannerJson,
  parsePipAuditJson,
} from '../src/index.js';

async function withTempRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archpilot-v120-'));
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

test('findUnusedDependencies detects unused Python deps in requirements.txt and pyproject.toml while honoring aliases', async () => {
  await withTempRepo(
    {
      'requirements.txt': [
        'fastapi==0.115.0',
        'pyyaml>=6.0',
        'uvicorn==0.30.0',
        'requests==2.32.0',
        '# comment',
      ].join('\n'),
      'pyproject.toml': [
        '[project]',
        'name = "demo"',
        'dependencies = [',
        '  "scikit-learn>=1.5",',
        '  "unused-lib>=0.1.0",',
        ']',
      ].join('\n'),
      'app/main.py': [
        'import yaml',
        'from fastapi import FastAPI',
        'from sklearn.linear_model import LogisticRegression',
        'app = FastAPI()',
      ].join('\n'),
    },
    async (dir) => {
      const res = await findUnusedDependencies(dir);
      assert.ok(res.ecosystemsChecked?.includes('python'));
      const names = res.unused.map((u) => u.name);
      assert.deepEqual(names, ['unused-lib', 'requests']);
      assert.ok(res.unused.every((u) => u.ecosystem === 'python'));
    }
  );
});

test('findUnusedDependencies detects unused Go direct requires while ignoring indirect modules', async () => {
  await withTempRepo(
    {
      'go.mod': [
        'module example.com/demo',
        '',
        'go 1.22',
        '',
        'require (',
        '  github.com/gin-gonic/gin v1.10.0',
        '  github.com/unused/pkg v0.4.0',
        '  golang.org/x/sys v0.20.0 // indirect',
        ')',
      ].join('\n'),
      'main.go': [
        'package main',
        'import (',
        '  "fmt"',
        '  "github.com/gin-gonic/gin"',
        ')',
        'func main() { fmt.Println(gin.Version) }',
      ].join('\n'),
    },
    async (dir) => {
      const res = await findUnusedDependencies(dir);
      assert.ok(res.ecosystemsChecked?.includes('go'));
      assert.equal(res.unused.length, 1);
      assert.equal(res.unused[0].name, 'github.com/unused/pkg');
      assert.equal(res.unused[0].ecosystem, 'go');
    }
  );
});

test('findUnusedDependencies detects unused Java deps in pom.xml and build.gradle while skipping starters and test scope', async () => {
  await withTempRepo(
    {
      'pom.xml': `
        <project>
          <dependencies>
            <dependency>
              <groupId>org.springframework.boot</groupId>
              <artifactId>spring-boot-starter-web</artifactId>
            </dependency>
            <dependency>
              <groupId>com.google.guava</groupId>
              <artifactId>guava</artifactId>
              <version>33.0.0-jre</version>
            </dependency>
            <dependency>
              <groupId>org.apache.commons</groupId>
              <artifactId>commons-csv</artifactId>
              <version>1.11.0</version>
            </dependency>
            <dependency>
              <groupId>org.junit.jupiter</groupId>
              <artifactId>junit-jupiter</artifactId>
              <scope>test</scope>
            </dependency>
          </dependencies>
        </project>
      `,
      'src/main/java/com/acme/App.java': [
        'package com.acme;',
        'import com.google.common.collect.ImmutableList;',
        'public class App {}',
      ].join('\n'),
    },
    async (dir) => {
      const res = await findUnusedDependencies(dir);
      assert.ok(res.ecosystemsChecked?.includes('java'));
      assert.equal(res.unused.length, 1);
      assert.equal(res.unused[0].name, 'org.apache.commons:commons-csv');
      assert.equal(res.unused[0].ecosystem, 'java');
    }
  );
});

test('parsePipAuditJson parses pip-audit JSON output', () => {
  const sample = JSON.stringify({
    dependencies: [
      {
        name: 'requests',
        vulns: [
          {
            id: 'CVE-2024-35195',
            description: 'Cert verification bypass on redirect',
            fix_versions: ['2.32.0'],
          },
        ],
      },
    ],
  });
  const vulns = parsePipAuditJson(sample);
  assert.equal(vulns.length, 1);
  assert.equal(vulns[0].ecosystem, 'python');
  assert.equal(vulns[0].packageName, 'requests');
  assert.equal(vulns[0].fixAvailable, true);
  assert.equal(vulns[0].fixedVersion, '2.32.0');
});

test('parseGoVulnCheckJson parses govulncheck JSON stream', () => {
  const stream = [
    JSON.stringify({
      osv: {
        id: 'GO-2024-1234',
        summary: 'HTTP/2 rapid reset DoS',
        references: [{ url: 'https://pkg.go.dev/vuln/GO-2024-1234' }],
      },
    }),
    JSON.stringify({
      finding: {
        osv: 'GO-2024-1234',
        fixed_version: 'v0.23.0',
        trace: [{ module: 'golang.org/x/net', package: 'golang.org/x/net/http2' }],
      },
    }),
  ].join('\n');

  const vulns = parseGoVulnCheckJson(stream);
  assert.equal(vulns.length, 1);
  assert.equal(vulns[0].ecosystem, 'go');
  assert.equal(vulns[0].packageName, 'golang.org/x/net');
  assert.equal(vulns[0].fixedVersion, 'v0.23.0');
});

test('parseOsvScannerJson parses Java Maven vulnerabilities', () => {
  const sample = JSON.stringify({
    results: [
      {
        packages: [
          {
            package: { name: 'org.apache.logging.log4j:log4j-core', ecosystem: 'Maven' },
            vulnerabilities: [
              {
                id: 'GHSA-jfh8-c2jp-5v3q',
                summary: 'Remote code execution in Log4j',
                database_specific: { severity: 'CRITICAL' },
                affected: [{ ranges: [{ events: [{ fixed: '2.17.1' }] }] }],
              },
            ],
          },
        ],
      },
    ],
  });

  const vulns = parseOsvScannerJson(sample, 'java');
  assert.equal(vulns.length, 1);
  assert.equal(vulns[0].ecosystem, 'java');
  assert.equal(vulns[0].severity, 'critical');
  assert.equal(vulns[0].fixedVersion, '2.17.1');
});
