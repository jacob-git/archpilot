import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildImportGraph } from './graph.js';
import { scanWorkspace } from './scanner.js';

export type DependencyEcosystem = 'npm' | 'python' | 'java' | 'go';

export interface UnusedDependencyInfo {
  name: string;
  version: string;
  packageJsonPath: string;
  ecosystem?: DependencyEcosystem;
}

export interface UnusedDepsReport {
  rootDir: string;
  totalDependencies: number;
  unused: UnusedDependencyInfo[];
  ecosystemsChecked?: DependencyEcosystem[];
}

const IMPLICIT_RUNTIME_DEPS = new Set([
  'tslib',
  'reflect-metadata',
  'zone.js',
  'core-js',
  'regenerator-runtime',
  'dotenv',
]);

const PYTHON_IMPLICIT_DEPS = new Set([
  'uvicorn',
  'gunicorn',
  'pytest',
  'mypy',
  'ruff',
  'black',
  'flake8',
  'isort',
  'alembic',
  'pip',
  'setuptools',
  'wheel',
  'poetry',
  'cython',
  'psycopg2_binary',
  'psycopg2',
  'pymysql',
  'asyncpg',
  'aiosqlite',
]);

const PYTHON_DIST_ALIASES: Record<string, string[]> = {
  scikit_learn: ['sklearn'],
  pillow: ['pil'],
  pyyaml: ['yaml'],
  beautifulsoup4: ['bs4'],
  python_dotenv: ['dotenv'],
  python_dateutil: ['dateutil'],
  opencv_python: ['cv2'],
  opencv_python_headless: ['cv2'],
  pyjwt: ['jwt'],
  python_multipart: ['multipart'],
  google_generativeai: ['google'],
  google_cloud_storage: ['google'],
  protobuf: ['google'],
  attrs: ['attr', 'attrs'],
  pycryptodome: ['crypto'],
};

const JAVA_IMPLICIT_ARTIFACTS =
  /^(spring-boot-starter|lombok|slf4j|logback|log4j|junit|mockito|assertj|hamcrest|h2|postgresql|mysql-connector|mariadb-java-client|ojdbc|mssql-jdbc|micrometer|jackson-datatype|jackson-module|hibernate-validator|jakarta\.validation|javax\.validation|mapstruct|flyway|liquibase)/i;

const JAVA_ARTIFACT_IMPORT_HINTS: Record<string, string[]> = {
  guava: ['com.google.common'],
  gson: ['com.google.gson'],
  okhttp: ['okhttp3'],
  retrofit: ['retrofit2'],
  'commons-lang3': ['org.apache.commons.lang3'],
  'commons-io': ['org.apache.commons.io'],
};

function normalizePackageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

function normalizePythonName(name: string): string {
  return name.trim().toLowerCase().replace(/[-.]+/g, '_');
}

function parsePythonReqSpec(rawLine: string): { name: string; version: string } | undefined {
  const cleaned = rawLine.split('#')[0].split(';')[0].trim();
  if (!cleaned || cleaned.startsWith('-') || cleaned.startsWith('git+') || cleaned.startsWith('http')) {
    return undefined;
  }
  const m = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\[[^\]]+\])?\s*([<>=!~^].*)?$/.exec(cleaned);
  if (!m) return undefined;
  return { name: m[1], version: (m[2] ?? '*').trim() };
}

function parsePyprojectDeps(content: string): Array<{ name: string; version: string }> {
  const results: Array<{ name: string; version: string }> = [];
  // PEP 621: [project] dependencies = [ "pkg>=1.0", ... ]
  const pep621Match = /\bdependencies\s*=\s*\[([\s\S]*?)\]/m.exec(content);
  if (pep621Match) {
    const strRe = /['"]([^'"]+)['"]/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(pep621Match[1])) !== null) {
      const parsed = parsePythonReqSpec(sm[1]);
      if (parsed) results.push(parsed);
    }
  }
  // Poetry: [tool.poetry.dependencies]
  const poetryMatch = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(content);
  if (poetryMatch) {
    for (const line of poetryMatch[1].split(/\r?\n/)) {
      const trimmed = line.split('#')[0].trim();
      if (!trimmed) continue;
      const kv = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*=\s*(.+)$/.exec(trimmed);
      if (!kv) continue;
      if (kv[1].toLowerCase() === 'python') continue;
      const version = kv[2].replace(/^['"]|['"]$/g, '').trim();
      results.push({ name: kv[1], version });
    }
  }
  return results;
}

function parseGoModRequires(content: string): Array<{ modulePath: string; version: string }> {
  const results: Array<{ modulePath: string; version: string }> = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (/^require\s*\($/.test(trimmed)) {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed === ')') {
      inBlock = false;
      continue;
    }
    if (/\/\/\s*indirect\b/.test(trimmed)) continue;
    const body = inBlock ? trimmed : trimmed.startsWith('require ') ? trimmed.slice('require '.length).trim() : '';
    if (!body) continue;
    const m = /^([^\s]+)\s+([^\s]+)/.exec(body);
    if (m) {
      results.push({ modulePath: m[1], version: m[2] });
    }
  }
  return results;
}

function parsePomDependencies(content: string): Array<{ groupId: string; artifactId: string; version: string }> {
  const results: Array<{ groupId: string; artifactId: string; version: string }> = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(content)) !== null) {
    const block = m[1];
    const scope = /<scope>\s*([^<\s]+)\s*<\/scope>/.exec(block)?.[1]?.toLowerCase();
    if (scope && scope !== 'compile') continue;
    const groupId = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block)?.[1];
    const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block)?.[1];
    if (!groupId || !artifactId) continue;
    const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(block)?.[1] ?? 'managed';
    results.push({ groupId, artifactId, version });
  }
  return results;
}

function parseGradleDependencies(content: string): Array<{ groupId: string; artifactId: string; version: string }> {
  const results: Array<{ groupId: string; artifactId: string; version: string }> = [];
  const re = /^\s*(?:implementation|api)\s*\(?\s*['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]\s*\)?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    results.push({
      groupId: m[1],
      artifactId: m[2],
      version: m[3] ?? 'managed',
    });
  }
  return results;
}

function isJavaDepUsed(
  groupId: string,
  artifactId: string,
  javaImports: string[],
  searchBlob: string
): boolean {
  const hints = JAVA_ARTIFACT_IMPORT_HINTS[artifactId.toLowerCase()] ?? [];
  const groupPrefix = groupId.toLowerCase();
  const groupShort = groupPrefix.split('.').slice(0, 2).join('.');
  const artifactToken = artifactId.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const imp of javaImports) {
    const lower = imp.toLowerCase();
    if (lower.startsWith(`${groupPrefix}.`) || lower === groupPrefix) return true;
    if (hints.some((h) => lower.startsWith(`${h}.`) || lower === h)) return true;
    if (groupShort.includes('.') && lower.startsWith(`${groupShort}.`)) {
      // Only match 2-segment group if artifact token also appears in the import
      const impCompact = lower.replace(/[^a-z0-9]/g, '');
      if (artifactToken.length >= 4 && impCompact.includes(artifactToken)) return true;
    }
  }
  if (searchBlob.includes(artifactId)) return true;
  return false;
}

export async function findUnusedDependencies(rootDir: string): Promise<UnusedDepsReport> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));
  const edges = await buildImportGraph(files, fileSet);

  const usedNpmPackages = new Set<string>();
  const usedPythonModules = new Set<string>();
  const usedGoImports: string[] = [];
  const usedJavaImports: string[] = [];

  for (const edge of edges) {
    if (edge.from.endsWith('.py')) {
      if (!edge.specifier.startsWith('.')) {
        usedPythonModules.add(normalizePythonName(edge.specifier.split('.')[0]));
      }
    } else if (edge.from.endsWith('.go')) {
      usedGoImports.push(edge.specifier);
    } else if (edge.from.endsWith('.java')) {
      usedJavaImports.push(edge.specifier);
    } else {
      const pkg = normalizePackageName(edge.specifier);
      if (pkg) usedNpmPackages.add(pkg);
    }
  }

  // Also check config files, CSS imports, and package.json scripts for indirect references
  const extraTextChunks: string[] = [];
  const configFiles = files.filter((f) =>
    /(^|\/)((next|vite|webpack|babel|postcss|tailwind|eslint|jest|vitest|svelte|nuxt|astro)\.config\.|\.(babelrc|eslintrc|postcssrc))|\.(css|scss|less)$/i.test(
      f.relPath
    )
  );
  await Promise.all(
    configFiles.slice(0, 40).map(async (f) => {
      if (f.sizeBytes > 150_000) return;
      try {
        extraTextChunks.push(await readFile(f.absPath, 'utf8'));
      } catch {
        // ignore
      }
    })
  );

  const ecosystemsSet = new Set<DependencyEcosystem>();
  let totalDependencies = 0;
  const unused: UnusedDependencyInfo[] = [];

  // 1. Node / npm (package.json)
  const pkgFiles = files.filter(
    (f) => path.basename(f.relPath) === 'package.json' && f.relPath.split('/').length <= 3
  );
  for (const pkgFile of pkgFiles) {
    let parsed: {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    try {
      parsed = JSON.parse(await readFile(pkgFile.absPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
    } catch {
      continue;
    }

    ecosystemsSet.add('npm');
    const scriptsBlob = Object.values(parsed.scripts ?? {}).join('\n');
    const searchBlob = `${scriptsBlob}\n${extraTextChunks.join('\n')}`;

    for (const [depName, version] of Object.entries(parsed.dependencies ?? {})) {
      totalDependencies += 1;
      if (depName.startsWith('@types/') || IMPLICIT_RUNTIME_DEPS.has(depName)) continue;
      if (usedNpmPackages.has(depName)) continue;
      if (searchBlob.includes(depName)) continue;

      unused.push({
        name: depName,
        version,
        packageJsonPath: pkgFile.relPath,
        ecosystem: 'npm',
      });
    }
  }

  // 2. Python (requirements.txt, pyproject.toml)
  const hasPythonCode = files.some((f) => f.ext === '.py');
  const pyManifests = files.filter(
    (f) =>
      (path.basename(f.relPath) === 'requirements.txt' || path.basename(f.relPath) === 'pyproject.toml') &&
      f.relPath.split('/').length <= 3
  );
  if (hasPythonCode && pyManifests.length > 0) {
    ecosystemsSet.add('python');
    for (const manifest of pyManifests) {
      let content = '';
      try {
        content = await readFile(manifest.absPath, 'utf8');
      } catch {
        continue;
      }
      const deps =
        path.basename(manifest.relPath) === 'requirements.txt'
          ? content
              .split(/\r?\n/)
              .map(parsePythonReqSpec)
              .filter((d): d is { name: string; version: string } => Boolean(d))
          : parsePyprojectDeps(content);

      for (const dep of deps) {
        totalDependencies += 1;
        const norm = normalizePythonName(dep.name);
        if (PYTHON_IMPLICIT_DEPS.has(norm)) continue;
        const candidates = [norm, ...(PYTHON_DIST_ALIASES[norm] ?? [])];
        if (candidates.some((c) => usedPythonModules.has(c))) continue;

        unused.push({
          name: dep.name,
          version: dep.version,
          packageJsonPath: manifest.relPath,
          ecosystem: 'python',
        });
      }
    }
  }

  // 3. Go (go.mod)
  const hasGoCode = files.some((f) => f.ext === '.go');
  const goModFiles = files.filter(
    (f) => path.basename(f.relPath) === 'go.mod' && f.relPath.split('/').length <= 3
  );
  if (hasGoCode && goModFiles.length > 0) {
    ecosystemsSet.add('go');
    for (const goMod of goModFiles) {
      let content = '';
      try {
        content = await readFile(goMod.absPath, 'utf8');
      } catch {
        continue;
      }
      const requires = parseGoModRequires(content);
      for (const req of requires) {
        totalDependencies += 1;
        const used = usedGoImports.some(
          (imp) => imp === req.modulePath || imp.startsWith(`${req.modulePath}/`)
        );
        if (!used) {
          unused.push({
            name: req.modulePath,
            version: req.version,
            packageJsonPath: goMod.relPath,
            ecosystem: 'go',
          });
        }
      }
    }
  }

  // 4. Java (pom.xml, build.gradle, build.gradle.kts)
  const hasJavaCode = files.some((f) => f.ext === '.java');
  const javaManifests = files.filter(
    (f) =>
      (path.basename(f.relPath) === 'pom.xml' ||
        path.basename(f.relPath) === 'build.gradle' ||
        path.basename(f.relPath) === 'build.gradle.kts') &&
      f.relPath.split('/').length <= 3
  );
  if (hasJavaCode && javaManifests.length > 0) {
    ecosystemsSet.add('java');
    const searchBlob = extraTextChunks.join('\n');
    for (const manifest of javaManifests) {
      let content = '';
      try {
        content = await readFile(manifest.absPath, 'utf8');
      } catch {
        continue;
      }
      const deps =
        path.basename(manifest.relPath) === 'pom.xml'
          ? parsePomDependencies(content)
          : parseGradleDependencies(content);

      for (const dep of deps) {
        totalDependencies += 1;
        if (JAVA_IMPLICIT_ARTIFACTS.test(dep.artifactId)) continue;
        if (isJavaDepUsed(dep.groupId, dep.artifactId, usedJavaImports, searchBlob)) continue;

        unused.push({
          name: `${dep.groupId}:${dep.artifactId}`,
          version: dep.version,
          packageJsonPath: manifest.relPath,
          ecosystem: 'java',
        });
      }
    }
  }

  unused.sort((a, b) => a.packageJsonPath.localeCompare(b.packageJsonPath) || a.name.localeCompare(b.name));

  return {
    rootDir: path.resolve(rootDir),
    totalDependencies,
    unused,
    ecosystemsChecked: [...ecosystemsSet],
  };
}
