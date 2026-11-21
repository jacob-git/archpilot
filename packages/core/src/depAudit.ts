import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DepSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface DependencyVulnerability {
  ecosystem: 'npm' | 'python' | 'rust';
  packageName: string;
  severity: DepSeverity;
  title: string;
  url?: string;
  fixAvailable: boolean;
  isBreakingFix: boolean;
  fixedVersion?: string;
}

export interface DependencyAuditReport {
  rootDir: string;
  ecosystemsChecked: string[];
  registryUsed?: string;
  usedPublicFallback: boolean;
  vulnerabilities: DependencyVulnerability[];
  counts: {
    critical: number;
    high: number;
    moderate: number;
    low: number;
    total: number;
  };
  notes: string[];
}

export interface DependencyAuditOptions {
  npmRegistry?: string;
}

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function execAllowNonZero(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: 25_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export function parseNpmAuditJson(rawJson: string): {
  vulnerabilities: DependencyVulnerability[];
  auditEndpointError?: string;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return { vulnerabilities: [], auditEndpointError: 'Unparseable npm audit output' };
  }

  // Detect corporate registry missing audit endpoint (ENOAUDIT / 404 / 405 / 501)
  if (parsed.error && typeof parsed.error === 'object') {
    const errObj = parsed.error as { code?: string; summary?: string };
    const code = String(errObj.code ?? '');
    const summary = String(errObj.summary ?? '');
    return { vulnerabilities: [], auditEndpointError: `${code}: ${summary}`.trim() };
  }

  const vulnsObj = parsed.vulnerabilities;
  if (!vulnsObj || typeof vulnsObj !== 'object') {
    return { vulnerabilities: [] };
  }

  const results: DependencyVulnerability[] = [];
  for (const [pkgName, rawEntry] of Object.entries(vulnsObj as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as {
      severity?: string;
      via?: Array<string | { title?: string; url?: string }>;
      fixAvailable?: boolean | { version?: string; isSemVerMajor?: boolean };
    };

    const sev = (['critical', 'high', 'moderate', 'low', 'info'].includes(entry.severity ?? '')
      ? entry.severity
      : 'moderate') as DepSeverity;

    let title = `Vulnerability in ${pkgName}`;
    let url: string | undefined;
    if (Array.isArray(entry.via)) {
      const advisory = entry.via.find(
        (v): v is { title?: string; url?: string } => typeof v === 'object' && v !== null
      );
      if (advisory?.title) title = advisory.title;
      if (advisory?.url) url = advisory.url;
    }

    let fixAvailable = false;
    let isBreakingFix = false;
    let fixedVersion: string | undefined;
    if (entry.fixAvailable === true) {
      fixAvailable = true;
    } else if (entry.fixAvailable && typeof entry.fixAvailable === 'object') {
      fixAvailable = true;
      isBreakingFix = Boolean(entry.fixAvailable.isSemVerMajor);
      fixedVersion = entry.fixAvailable.version;
    }

    results.push({
      ecosystem: 'npm',
      packageName: pkgName,
      severity: sev,
      title,
      url,
      fixAvailable,
      isBreakingFix,
      fixedVersion,
    });
  }

  const order: Record<DepSeverity, number> = {
    critical: 0,
    high: 1,
    moderate: 2,
    low: 3,
    info: 4,
  };
  results.sort((a, b) => order[a.severity] - order[b.severity]);
  return { vulnerabilities: results };
}

export async function runDependencyAudit(
  rootDir: string,
  options?: DependencyAuditOptions
): Promise<DependencyAuditReport> {
  const resolvedRoot = path.resolve(rootDir);
  const ecosystemsChecked: string[] = [];
  const vulnerabilities: DependencyVulnerability[] = [];
  const notes: string[] = [];
  let registryUsed: string | undefined;
  let usedPublicFallback = false;

  // 1. Node / npm audit (with automatic fallback to public npmjs.org if internal corporate registry lacks audit endpoint)
  const hasPkg = await fileExists(path.join(resolvedRoot, 'package.json'));
  const hasLock = await fileExists(path.join(resolvedRoot, 'package-lock.json'));
  if (hasPkg && hasLock) {
    ecosystemsChecked.push('npm');
    const customReg = options?.npmRegistry?.trim();
    const baseArgs = ['audit', '--json'];
    if (customReg) {
      baseArgs.push(`--registry=${customReg}`);
      registryUsed = customReg;
    }

    const first = await execAllowNonZero('npm', baseArgs, resolvedRoot);
    let parsed = parseNpmAuditJson(first.stdout);

    if (
      parsed.auditEndpointError &&
      !customReg &&
      /ENOAUDIT|E404|E405|E501|not implemented|Unparseable/i.test(
        `${parsed.auditEndpointError} ${first.stderr}`
      )
    ) {
      // Corporate registry (Artifactory/Nexus/GitHub Packages) often disables the audit endpoint; retry against public npmjs.org
      const fallback = await execAllowNonZero(
        'npm',
        ['audit', '--json', `--registry=${PUBLIC_NPM_REGISTRY}`],
        resolvedRoot
      );
      const fallbackParsed = parseNpmAuditJson(fallback.stdout);
      if (!fallbackParsed.auditEndpointError) {
        parsed = fallbackParsed;
        usedPublicFallback = true;
        registryUsed = PUBLIC_NPM_REGISTRY;
        notes.push(
          `Default npm registry did not support security audits; automatically queried public registry (${PUBLIC_NPM_REGISTRY}).`
        );
      } else {
        notes.push(
          `npm audit unavailable (${parsed.auditEndpointError}). If behind a corporate proxy/firewall, configure \`archpilot.npmAuditRegistry\`.`
        );
      }
    } else if (parsed.auditEndpointError) {
      notes.push(`npm audit could not complete: ${parsed.auditEndpointError}`);
    }

    vulnerabilities.push(...parsed.vulnerabilities);
  } else if (hasPkg && !hasLock) {
    notes.push('package.json found without package-lock.json: run `npm install` to enable npm CVE auditing.');
  }

  // 2. Python (pip-audit if installed locally)
  if (
    (await fileExists(path.join(resolvedRoot, 'requirements.txt'))) ||
    (await fileExists(path.join(resolvedRoot, 'pyproject.toml')))
  ) {
    const pyCheck = await execAllowNonZero('pip-audit', ['--format', 'json'], resolvedRoot);
    if (pyCheck.stdout.trim().startsWith('{') || pyCheck.stdout.trim().startsWith('[')) {
      ecosystemsChecked.push('python');
      try {
        const data = JSON.parse(pyCheck.stdout) as {
          dependencies?: Array<{
            name: string;
            vulns?: Array<{ id: string; description?: string; fix_versions?: string[] }>;
          }>;
        };
        for (const dep of data.dependencies ?? []) {
          for (const v of dep.vulns ?? []) {
            vulnerabilities.push({
              ecosystem: 'python',
              packageName: dep.name,
              severity: 'high',
              title: `${v.id}${v.description ? `: ${v.description.slice(0, 120)}` : ''}`,
              fixAvailable: Boolean(v.fix_versions && v.fix_versions.length > 0),
              isBreakingFix: false,
              fixedVersion: v.fix_versions?.[0],
            });
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  const counts = {
    critical: vulnerabilities.filter((v) => v.severity === 'critical').length,
    high: vulnerabilities.filter((v) => v.severity === 'high').length,
    moderate: vulnerabilities.filter((v) => v.severity === 'moderate').length,
    low: vulnerabilities.filter((v) => v.severity === 'low').length,
    total: vulnerabilities.length,
  };

  return {
    rootDir: resolvedRoot,
    ecosystemsChecked,
    registryUsed,
    usedPublicFallback,
    vulnerabilities,
    counts,
    notes,
  };
}
