import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CheckContext,
  Finding,
  MigrationBlocker,
  MigrationPlan,
  MigrationPlaybookId,
  MigrationPlaybookMeta,
  MigrationRuleConfig,
  MigrationWave,
  MigrationWaveFile,
  ScannedFile,
  Severity,
} from './types.js';
import { loadConfig } from './config.js';
import { buildImportGraph, extractImports } from './graph.js';
import { CODE_EXTENSIONS, scanWorkspace } from './scanner.js';

interface PatternCheck {
  ruleId: string;
  severity: Severity;
  exts: Set<string>;
  regex: RegExp;
  message: string;
  suggestion: string;
  skipFileRegex?: RegExp;
}

interface PlaybookDefinition {
  id: Exclude<MigrationPlaybookId, 'custom'>;
  name: string;
  description: string;
  fileNameChecks?: Array<{
    ruleId: string;
    severity: Severity;
    match: RegExp;
    message: string;
    suggestion: string;
  }>;
  patternChecks: PatternCheck[];
}

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const HTML_EXTS = new Set(['.html', '.htm']);
const JAVA_EXTS = new Set(['.java', '.kt']);
const SPRING_CFG_EXTS = new Set(['.properties', '.yml', '.yaml']);
const PY_EXTS = new Set(['.py']);

const BUILTIN_PLAYBOOKS: PlaybookDefinition[] = [
  {
    id: 'webpack-to-vite',
    name: 'Webpack / CRA -> Vite',
    description: 'Detect Webpack config files, REACT_APP_* env vars, CommonJS require(), and CRA HTML placeholders',
    fileNameChecks: [
      {
        ruleId: 'mig-webpack-config',
        severity: 'error',
        match: /(^|\/)(webpack|craco)\.config\.(js|cjs|mjs|ts)$/i,
        message: 'Legacy Webpack/CRACO configuration file found.',
        suggestion: 'Replace with vite.config.ts and move aliases/plugins to Vite.',
      },
    ],
    patternChecks: [
      {
        ruleId: 'mig-cra-env',
        severity: 'error',
        exts: JS_TS_EXTS,
        regex: /\bprocess\.env\.(REACT_APP_|VUE_APP_)[A-Z0-9_]+/,
        message: 'Uses process.env.REACT_APP_* / VUE_APP_* which Vite does not inject.',
        suggestion: 'Rename env variables to VITE_* and read via import.meta.env.VITE_*.',
      },
      {
        ruleId: 'mig-require-context',
        severity: 'error',
        exts: JS_TS_EXTS,
        regex: /\brequire\.context\s*\(/,
        message: 'Uses Webpack-specific require.context().',
        suggestion: 'Replace with Vite import.meta.glob().',
      },
      {
        ruleId: 'mig-cjs-require',
        severity: 'warning',
        exts: new Set(['.ts', '.tsx', '.js', '.jsx']),
        regex: /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/,
        message: 'Uses CommonJS require() in frontend source.',
        suggestion: 'Convert to static ES import or dynamic import().',
        skipFileRegex: /(^|\/)(vite|jest|vitest|babel|postcss|tailwind|eslint)\.config\./i,
      },
      {
        ruleId: 'mig-public-url',
        severity: 'error',
        exts: HTML_EXTS,
        regex: /%PUBLIC_URL%/,
        message: 'Uses CRA %PUBLIC_URL% placeholder in HTML.',
        suggestion: 'Move index.html to project root and replace %PUBLIC_URL%/ with /.',
      },
      {
        ruleId: 'mig-tilde-css-import',
        severity: 'warning',
        exts: STYLE_EXTS,
        regex: /@import\s+['"]~/,
        message: 'Uses Webpack tilde (~) CSS import prefix.',
        suggestion: 'Remove the leading ~ so Vite resolves the package from node_modules.',
      },
      {
        ruleId: 'mig-react-scripts-dep',
        severity: 'error',
        exts: new Set(['.json']),
        regex: /"react-scripts"\s*:/,
        message: 'package.json still depends on react-scripts.',
        suggestion: 'Remove react-scripts and install vite + @vitejs/plugin-react.',
      },
    ],
  },
  {
    id: 'spring-boot-3-to-4',
    name: 'Spring Boot 3 -> 4 (Jakarta / Java 21+)',
    description: 'Detect leftover javax.* imports, deprecated security configs, RestTemplate, field @Autowired, and JUnit 4',
    patternChecks: [
      {
        ruleId: 'mig-javax-import',
        severity: 'error',
        exts: JAVA_EXTS,
        regex: /^\s*import\s+javax\.(persistence|servlet|validation|annotation|transaction|ws\.rs)\./,
        message: 'Uses legacy javax.* namespace removed in Jakarta EE / Spring Boot 3+.',
        suggestion: 'Replace javax.* imports with jakarta.* equivalents.',
      },
      {
        ruleId: 'mig-web-security-adapter',
        severity: 'error',
        exts: JAVA_EXTS,
        regex: /\b(WebSecurityConfigurerAdapter|antMatchers\s*\()/,
        message: 'Uses removed Spring Security WebSecurityConfigurerAdapter or antMatchers().',
        suggestion: 'Define a SecurityFilterChain @Bean using requestMatchers().',
      },
      {
        ruleId: 'mig-resttemplate',
        severity: 'warning',
        exts: JAVA_EXTS,
        regex: /\bnew\s+RestTemplate\s*\(|\bRestTemplate\b/,
        message: 'Uses legacy RestTemplate client.',
        suggestion: 'Migrate to RestClient (Spring 6.1+) or @HttpExchange declarative clients.',
      },
      {
        ruleId: 'mig-junit4',
        severity: 'warning',
        exts: JAVA_EXTS,
        regex: /^\s*import\s+org\.junit\.(Test|Before|After|runner\.RunWith)\b/,
        message: 'Uses legacy JUnit 4 API.',
        suggestion: 'Migrate to JUnit 5 (org.junit.jupiter.api.Test and @ExtendWith).',
      },
      {
        ruleId: 'mig-spring-profiles-prop',
        severity: 'error',
        exts: SPRING_CFG_EXTS,
        regex: /^\s*spring\.profiles\s*[:=]/,
        message: 'Uses removed spring.profiles property.',
        suggestion: 'Replace with spring.config.activate.on-profile.',
      },
    ],
  },
  {
    id: 'cjs-to-esm',
    name: 'CommonJS -> ES Modules (ESM)',
    description: 'Detect require(), module.exports, __dirname/__filename, and missing type: module',
    patternChecks: [
      {
        ruleId: 'mig-cjs-require',
        severity: 'error',
        exts: new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs']),
        regex: /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/,
        message: 'Uses CommonJS require().',
        suggestion: 'Replace with ES import statement or dynamic import().',
      },
      {
        ruleId: 'mig-module-exports',
        severity: 'error',
        exts: new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs']),
        regex: /\b(module\.exports|exports\.[a-zA-Z0-9_$]+)\s*=/,
        message: 'Uses CommonJS module.exports / exports assignment.',
        suggestion: 'Replace with ES export / export default.',
      },
      {
        ruleId: 'mig-dirname-global',
        severity: 'warning',
        exts: JS_TS_EXTS,
        regex: /\b(__dirname|__filename)\b/,
        message: 'Uses CommonJS __dirname or __filename global.',
        suggestion: 'Use import.meta.dirname / import.meta.filename (Node 20.11+) or fileURLToPath(import.meta.url).',
      },
    ],
  },
  {
    id: 'react-18-to-19',
    name: 'React 18 -> 19',
    description: 'Detect ReactDOM.render, forwardRef, defaultProps, propTypes, and findDOMNode',
    patternChecks: [
      {
        ruleId: 'mig-reactdom-render',
        severity: 'error',
        exts: JS_TS_EXTS,
        regex: /\bReactDOM\.(render|hydrate)\s*\(/,
        message: 'Uses removed ReactDOM.render() / ReactDOM.hydrate().',
        suggestion: 'Migrate to createRoot() / hydrateRoot() from react-dom/client.',
      },
      {
        ruleId: 'mig-find-dom-node',
        severity: 'error',
        exts: JS_TS_EXTS,
        regex: /\bfindDOMNode\s*\(/,
        message: 'Uses removed ReactDOM.findDOMNode().',
        suggestion: 'Replace with DOM refs passed directly to elements.',
      },
      {
        ruleId: 'mig-default-props',
        severity: 'warning',
        exts: JS_TS_EXTS,
        regex: /\.defaultProps\s*=/,
        message: 'Uses component.defaultProps (removed for function components in React 19).',
        suggestion: 'Use ES6 default parameter values in the component signature.',
      },
      {
        ruleId: 'mig-prop-types',
        severity: 'warning',
        exts: JS_TS_EXTS,
        regex: /\.propTypes\s*=/,
        message: 'Uses runtime propTypes (ignored in React 19).',
        suggestion: 'Remove propTypes and rely on TypeScript interfaces.',
      },
      {
        ruleId: 'mig-forward-ref',
        severity: 'info',
        exts: JS_TS_EXTS,
        regex: /\bforwardRef\s*(<[^>]*>)?\s*\(/,
        message: 'Uses forwardRef() wrapper (optional cleanup in React 19).',
        suggestion: 'In React 19, ref can be accepted directly as a standard prop.',
      },
    ],
  },
  {
    id: 'pydantic-v1-to-v2',
    name: 'Pydantic v1 -> v2 / FastAPI',
    description: 'Detect @validator, @root_validator, .dict(), .parse_obj(), and class Config',
    patternChecks: [
      {
        ruleId: 'mig-pydantic-validator',
        severity: 'error',
        exts: PY_EXTS,
        regex: /^\s*@(validator|root_validator)\s*\(/,
        message: 'Uses Pydantic v1 @validator / @root_validator decorator.',
        suggestion: 'Replace with @field_validator or @model_validator(mode=...).',
      },
      {
        ruleId: 'mig-pydantic-dict',
        severity: 'warning',
        exts: PY_EXTS,
        regex: /\.(dict|parse_obj|from_orm)\s*\(/,
        message: 'Uses deprecated Pydantic v1 method (.dict / .parse_obj / .from_orm).',
        suggestion: 'Replace with .model_dump(), .model_validate(), or model_validate(..., from_attributes=True).',
      },
      {
        ruleId: 'mig-pydantic-config',
        severity: 'warning',
        exts: PY_EXTS,
        regex: /^\s+class\s+Config\s*:/,
        message: 'Uses Pydantic v1 nested class Config.',
        suggestion: 'Replace with model_config = ConfigDict(...).',
      },
    ],
  },
];

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export async function suggestMigrationPlaybooks(rootDir: string): Promise<MigrationPlaybookMeta[]> {
  const { config } = await loadConfig(rootDir);
  const pkgRaw = await readIfExists(path.join(rootDir, 'package.json'));
  const pomRaw = await readIfExists(path.join(rootDir, 'pom.xml'));
  const gradleRaw =
    (await readIfExists(path.join(rootDir, 'build.gradle'))) ??
    (await readIfExists(path.join(rootDir, 'build.gradle.kts')));
  const pyRaw =
    (await readIfExists(path.join(rootDir, 'pyproject.toml'))) ??
    (await readIfExists(path.join(rootDir, 'requirements.txt')));

  const result: MigrationPlaybookMeta[] = [];

  for (const rule of config.migrations ?? []) {
    result.push({
      id: 'custom',
      name: `${rule.name} (archpilot.json)`,
      description: rule.suggestion ?? 'Custom migration rule configured in archpilot.json',
      recommended: true,
      reason: 'Configured in archpilot.json',
      customRule: rule,
    });
  }

  for (const pb of BUILTIN_PLAYBOOKS) {
    let recommended = false;
    let reason: string | undefined;

    if (pb.id === 'webpack-to-vite' && pkgRaw) {
      if (/"(webpack|react-scripts|@craco\/craco)"\s*:/.test(pkgRaw)) {
        recommended = true;
        reason = 'Webpack / CRA detected in package.json';
      }
    } else if (pb.id === 'spring-boot-3-to-4' && (pomRaw || gradleRaw)) {
      if (/spring-boot/i.test(`${pomRaw ?? ''}\n${gradleRaw ?? ''}`)) {
        recommended = true;
        reason = 'Spring Boot detected in build file';
      }
    } else if (pb.id === 'react-18-to-19' && pkgRaw) {
      if (/"react"\s*:\s*"[^"]*1[678]\./.test(pkgRaw)) {
        recommended = true;
        reason = 'React 16-18 detected in package.json';
      }
    } else if (pb.id === 'cjs-to-esm' && pkgRaw) {
      if (!/"type"\s*:\s*"module"/.test(pkgRaw)) {
        recommended = true;
        reason = 'package.json does not set "type": "module"';
      }
    } else if (pb.id === 'pydantic-v1-to-v2' && pyRaw) {
      if (/pydantic|fastapi/i.test(pyRaw)) {
        recommended = true;
        reason = 'Pydantic / FastAPI detected';
      }
    }

    result.push({
      id: pb.id,
      name: pb.name,
      description: pb.description,
      recommended,
      reason,
    });
  }

  result.sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return result;
}

function buildWaves(
  blockers: MigrationBlocker[],
  reverseDependents: Map<string, Set<string>>
): MigrationWave[] {
  const byFile = new Map<string, MigrationBlocker[]>();
  for (const b of blockers) {
    const list = byFile.get(b.file) ?? [];
    list.push(b);
    byFile.set(b.file, list);
  }

  const wave1: MigrationWaveFile[] = [];
  const wave2: MigrationWaveFile[] = [];
  const wave3: MigrationWaveFile[] = [];

  for (const [file, fileBlockers] of byFile.entries()) {
    const depCount = reverseDependents.get(file)?.size ?? 0;
    const isRootConfig =
      !file.includes('/') ||
      /(config|package\.json|pom\.xml|build\.gradle|application\.(yml|yaml|properties))$/i.test(file);
    const entry: MigrationWaveFile = {
      file,
      dependentCount: depCount,
      blockerCount: fileBlockers.length,
      blockers: fileBlockers,
    };

    if (!isRootConfig && depCount === 0) {
      wave1.push(entry);
    } else if (!isRootConfig && depCount <= 2) {
      wave2.push(entry);
    } else {
      wave3.push(entry);
    }
  }

  const byBlockersDesc = (a: MigrationWaveFile, b: MigrationWaveFile) =>
    b.blockerCount - a.blockerCount || a.file.localeCompare(b.file);
  wave1.sort(byBlockersDesc);
  wave2.sort(byBlockersDesc);
  wave3.sort(byBlockersDesc);

  const waves: MigrationWave[] = [];
  if (wave1.length > 0) {
    waves.push({
      wave: 1,
      label: 'Wave 1: Leaf Files (0 dependents)',
      description: 'Safest to migrate and test first with zero downstream blast radius.',
      files: wave1,
    });
  }
  if (wave2.length > 0) {
    waves.push({
      wave: 2,
      label: 'Wave 2: Mid-Layer Modules (1-2 dependents)',
      description: 'Migrate after Wave 1 tests pass.',
      files: wave2,
    });
  }
  if (wave3.length > 0) {
    waves.push({
      wave: 3,
      label: 'Wave 3: Core Shared Modules & Configs',
      description: 'Highest blast radius and build/config entrypoints. Migrate last with full QA.',
      files: wave3,
    });
  }
  return waves;
}

async function scanCustomRule(
  files: ScannedFile[],
  rule: MigrationRuleConfig
): Promise<MigrationBlocker[]> {
  const blockers: MigrationBlocker[] = [];
  const compiledPatterns: RegExp[] = [];
  for (const raw of rule.forbidPatterns ?? []) {
    try {
      compiledPatterns.push(new RegExp(raw));
    } catch {
      // ignore invalid user regex
    }
  }
  const forbidImports = (rule.forbidImports ?? []).map((s) => s.trim()).filter(Boolean);
  const suggestion = rule.suggestion ?? `Migrate away from legacy usage for "${rule.name}".`;

  await Promise.all(
    files.map(async (file) => {
      if (file.sizeBytes > 300_000) return;
      if (!CODE_EXTENSIONS.has(file.ext) && !SPRING_CFG_EXTS.has(file.ext) && file.ext !== '.json' && !HTML_EXTS.has(file.ext)) {
        return;
      }
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }

      if (forbidImports.length > 0 && CODE_EXTENSIONS.has(file.ext)) {
        const imports = extractImports(content, file.ext);
        for (const imp of imports) {
          for (const forbidden of forbidImports) {
            if (imp.specifier === forbidden || imp.specifier.startsWith(`${forbidden}/`) || imp.specifier.includes(forbidden)) {
              blockers.push({
                file: file.relPath,
                line: imp.line,
                ruleId: 'custom-migration-import',
                severity: 'warning',
                message: `[${rule.name}] Forbidden legacy import "${imp.specifier}".`,
                suggestion,
              });
            }
          }
        }
      }

      if (compiledPatterns.length > 0) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          for (const regex of compiledPatterns) {
            if (regex.test(lineText)) {
              blockers.push({
                file: file.relPath,
                line: i + 1,
                ruleId: 'custom-migration-pattern',
                severity: 'warning',
                message: `[${rule.name}] Matched legacy pattern /${regex.source}/.`,
                suggestion,
              });
              break;
            }
          }
        }
      }
    })
  );

  return blockers;
}

export async function checkCustomMigrations(ctx: CheckContext): Promise<Finding[]> {
  const rules = ctx.config.migrations ?? [];
  if (rules.length === 0) return [];
  const findings: Finding[] = [];
  for (const rule of rules) {
    const blockers = await scanCustomRule(ctx.files, rule);
    for (const b of blockers.slice(0, 25)) {
      findings.push({
        id: b.ruleId,
        category: 'stack',
        severity: b.severity,
        file: b.file,
        line: b.line,
        message: b.message,
        suggestion: b.suggestion,
      });
    }
  }
  return findings;
}

export async function analyzeMigration(
  rootDir: string,
  options: {
    playbookId: MigrationPlaybookId;
    customRule?: MigrationRuleConfig;
  }
): Promise<MigrationPlan> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));
  const edges = await buildImportGraph(files, fileSet);

  const reverseDependents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.resolved || edge.resolved === edge.from) continue;
    const set = reverseDependents.get(edge.resolved) ?? new Set<string>();
    set.add(edge.from);
    reverseDependents.set(edge.resolved, set);
  }

  let name: string;
  let description: string;
  const blockers: MigrationBlocker[] = [];

  if (options.playbookId === 'custom' && options.customRule) {
    name = options.customRule.name;
    description = options.customRule.suggestion ?? 'Custom migration readiness scan';
    blockers.push(...(await scanCustomRule(files, options.customRule)));
  } else {
    const pb = BUILTIN_PLAYBOOKS.find((p) => p.id === options.playbookId) ?? BUILTIN_PLAYBOOKS[0];
    name = pb.name;
    description = pb.description;

    await Promise.all(
      files.map(async (file) => {
        for (const fnCheck of pb.fileNameChecks ?? []) {
          if (fnCheck.match.test(file.relPath)) {
            blockers.push({
              file: file.relPath,
              ruleId: fnCheck.ruleId,
              severity: fnCheck.severity,
              message: fnCheck.message,
              suggestion: fnCheck.suggestion,
            });
          }
        }

        const relevantChecks = pb.patternChecks.filter(
          (c) => c.exts.has(file.ext) && !(c.skipFileRegex && c.skipFileRegex.test(file.relPath))
        );
        if (relevantChecks.length === 0 || file.sizeBytes > 300_000) return;

        let content: string;
        try {
          content = await readFile(file.absPath, 'utf8');
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          const trimmed = lineText.trimStart();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
          for (const check of relevantChecks) {
            if (check.regex.test(lineText)) {
              blockers.push({
                file: file.relPath,
                line: i + 1,
                ruleId: check.ruleId,
                severity: check.severity,
                message: check.message,
                suggestion: check.suggestion,
              });
            }
          }
        }
      })
    );
  }

  blockers.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const waves = buildWaves(blockers, reverseDependents);
  const impactedFileCount = new Set(blockers.map((b) => b.file)).size;
  const estimatedEffort: MigrationPlan['estimatedEffort'] =
    impactedFileCount <= 5 && blockers.length <= 15
      ? 'low'
      : impactedFileCount <= 20 && blockers.length <= 60
        ? 'medium'
        : 'high';

  return {
    playbookId: options.playbookId,
    name,
    description,
    rootDir,
    totalBlockers: blockers.length,
    impactedFileCount,
    estimatedEffort,
    blockers,
    waves,
  };
}

export function generateMigrationPlanMd(plan: MigrationPlan): string {
  const lines: string[] = [
    `# Migration Plan: ${plan.name}`,
    '',
    `> Generated by ArchPilot (offline dependency-ordered upgrade planner).`,
    '',
    `- **Summary:** ${plan.description}`,
    `- **Impacted Files:** ${plan.impactedFileCount}`,
    `- **Total Blockers:** ${plan.totalBlockers}`,
    `- **Estimated Effort:** ${plan.estimatedEffort.toUpperCase()}`,
    '',
  ];

  if (plan.totalBlockers === 0) {
    lines.push('No migration blockers were detected for this playbook.');
    return lines.join('\n') + '\n';
  }

  for (const wave of plan.waves) {
    lines.push(`## ${wave.label}`);
    lines.push(wave.description);
    lines.push('');
    for (const f of wave.files) {
      lines.push(
        `- [ ] \`${f.file}\` (${f.blockerCount} blocker${f.blockerCount === 1 ? '' : 's'}, ${f.dependentCount} dependent${f.dependentCount === 1 ? '' : 's'})`
      );
      for (const b of f.blockers.slice(0, 8)) {
        const loc = b.line ? `L${b.line}` : 'file';
        lines.push(`  - **${loc} [${b.ruleId}]**: ${b.message} -> ${b.suggestion}`);
      }
      if (f.blockers.length > 8) {
        lines.push(`  - _...and ${f.blockers.length - 8} more in this file_`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function generateMigrationWavePrompt(plan: MigrationPlan, waveNumber?: number): string {
  const targetWave =
    plan.waves.find((w) => w.wave === waveNumber) ?? plan.waves[0];
  if (!targetWave) {
    return `No blockers found for migration "${plan.name}". Verify build and test suite.`;
  }

  const lines: string[] = [
    `You are executing **${targetWave.label}** of the **${plan.name}** migration.`,
    `Goal: ${plan.description}`,
    '',
    'Rules:',
    '1. Only modify the files listed in this wave so changes remain small and reviewable.',
    '2. Preserve existing behavior and run tests after updating these files.',
    '',
    'Files and exact blockers to fix:',
  ];

  for (const f of targetWave.files.slice(0, 20)) {
    lines.push(`\n### ${f.file} (${f.dependentCount} dependents)`);
    for (const b of f.blockers.slice(0, 10)) {
      const loc = b.line ? `Line ${b.line}` : 'File';
      lines.push(`- ${loc} [${b.ruleId}]: ${b.message} Fix: ${b.suggestion}`);
    }
  }

  return lines.join('\n');
}
