import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeMigration,
  auditRepository,
  generateMigrationPlanMd,
  generateMigrationWavePrompt,
  suggestMigrationPlaybooks,
} from '../src/index.js';

async function withTempRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archpilot-mig-'));
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

test('webpack-to-vite detects blockers and orders leaf files into Wave 1 and configs into Wave 3', async () => {
  await withTempRepo(
    {
      'package.json': JSON.stringify({
        name: 'cra-app',
        dependencies: { react: '^18.2.0', 'react-scripts': '5.0.1' },
      }),
      'webpack.config.js': 'module.exports = { entry: "./src/index.js" };\n',
      'public/index.html': '<link rel="icon" href="%PUBLIC_URL%/favicon.ico" />\n',
      'src/leafPage.ts': 'export const apiUrl = process.env.REACT_APP_API_URL;\n',
      'src/sharedEnv.ts': 'export const key = process.env.REACT_APP_KEY;\n',
      'src/a.ts': 'import { key } from "./sharedEnv";\nexport const a = key;\n',
      'src/b.ts': 'import { key } from "./sharedEnv";\nexport const b = key;\n',
      'src/c.ts': 'import { key } from "./sharedEnv";\nexport const c = key;\n',
    },
    async (dir) => {
      const suggestions = await suggestMigrationPlaybooks(dir);
      const vite = suggestions.find((s) => s.id === 'webpack-to-vite');
      assert.ok(vite?.recommended, 'Expected webpack-to-vite to be recommended');

      const plan = await analyzeMigration(dir, { playbookId: 'webpack-to-vite' });
      assert.ok(plan.totalBlockers >= 5, `Expected >=5 blockers, got ${plan.totalBlockers}`);
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-webpack-config'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-cra-env'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-public-url'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-react-scripts-dep'));

      const wave1 = plan.waves.find((w) => w.wave === 1);
      const wave3 = plan.waves.find((w) => w.wave === 3);
      assert.ok(wave1?.files.some((f) => f.file === 'src/leafPage.ts'), 'leafPage.ts should be in Wave 1');
      assert.ok(wave3?.files.some((f) => f.file === 'src/sharedEnv.ts'), 'sharedEnv.ts (3 dependents) should be in Wave 3');
      assert.ok(wave3?.files.some((f) => f.file === 'webpack.config.js'), 'webpack.config.js should be in Wave 3');

      const md = generateMigrationPlanMd(plan);
      assert.ok(md.includes('# Migration Plan: Webpack / CRA -> Vite'));
      assert.ok(md.includes('Wave 1: Leaf Files'));

      const prompt = generateMigrationWavePrompt(plan, 1);
      assert.ok(prompt.includes('src/leafPage.ts'));
    }
  );
});

test('spring-boot-3-to-4 detects javax imports, WebSecurityConfigurerAdapter, RestTemplate, and spring.profiles', async () => {
  await withTempRepo(
    {
      'pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
      'src/main/java/com/acme/SecurityConfig.java': [
        'package com.acme;',
        'import javax.servlet.http.HttpServletRequest;',
        'public class SecurityConfig extends WebSecurityConfigurerAdapter {',
        '  RestTemplate client = new RestTemplate();',
        '}',
      ].join('\n'),
      'src/main/resources/application.yml': 'spring.profiles: prod\n',
    },
    async (dir) => {
      const suggestions = await suggestMigrationPlaybooks(dir);
      const sb = suggestions.find((s) => s.id === 'spring-boot-3-to-4');
      assert.ok(sb?.recommended, 'Expected spring-boot-3-to-4 to be recommended');

      const plan = await analyzeMigration(dir, { playbookId: 'spring-boot-3-to-4' });
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-javax-import'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-web-security-adapter'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-resttemplate'));
      assert.ok(plan.blockers.some((b) => b.ruleId === 'mig-spring-profiles-prop'));
    }
  );
});

test('custom migrations in archpilot.json are enforced during auditRepository()', async () => {
  await withTempRepo(
    {
      'AGENTS.md': '# Agent Guide\nRun `npm test`.\n',
      'package.json': JSON.stringify({ name: 'custom-mig-app', scripts: { test: 'echo ok' } }),
      'archpilot.json': JSON.stringify({
        migrations: [
          {
            name: 'moment -> dayjs',
            forbidImports: ['moment'],
            suggestion: 'Use dayjs instead of moment.',
          },
        ],
      }),
      'src/dateUtil.ts': 'import moment from "moment";\nexport const now = () => moment().format();\n',
    },
    async (dir) => {
      const report = await auditRepository(dir);
      const migFinding = report.findings.find((f) => f.id === 'custom-migration-import');
      assert.ok(migFinding, 'Expected custom-migration-import finding in auditRepository()');
      assert.equal(migFinding.file, 'src/dateUtil.ts');
      assert.ok(migFinding.message.includes('moment -> dayjs'));
    }
  );
});
