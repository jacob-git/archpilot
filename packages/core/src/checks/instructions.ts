import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckContext, Finding } from '../types.js';

const INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
];

function isInstructionFile(relPath: string): boolean {
  if (INSTRUCTION_CANDIDATES.includes(relPath)) {
    return true;
  }
  if (relPath.startsWith('.cursor/rules/') && (relPath.endsWith('.mdc') || relPath.endsWith('.md'))) {
    return true;
  }
  return false;
}

const PATH_TOKEN_RE = /`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,8})`/g;
const NPM_SCRIPT_RE = /npm\s+run\s+([a-zA-Z0-9_:-]+)/g;

export async function runInstructionsCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const instructionFiles = ctx.files.filter((f) => isInstructionFile(f.relPath));

  if (instructionFiles.length === 0) {
    findings.push({
      id: 'missing-agent-instructions',
      category: 'instructions',
      severity: 'warning',
      message: 'No agent instruction file found (AGENTS.md, CLAUDE.md, .cursor/rules, or copilot-instructions.md).',
      suggestion: 'Run "ArchPilot: Generate AGENTS.md" or `archpilot --init` to create one.',
    });
    return findings;
  }

  const pkgScripts =
    ctx.packageJson && typeof ctx.packageJson.scripts === 'object' && ctx.packageJson.scripts !== null
      ? new Set(Object.keys(ctx.packageJson.scripts as Record<string, unknown>))
      : undefined;

  for (const file of instructionFiles) {
    let content: string;
    try {
      content = await readFile(file.absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);

    if (lines.length > 300) {
      findings.push({
        id: 'bloated-instructions',
        category: 'instructions',
        severity: 'warning',
        file: file.relPath,
        line: 1,
        message: `${file.relPath} is ${lines.length} lines long; overly long instructions dilute agent focus.`,
        suggestion: 'Keep root instructions concise (<300 lines) and split domain details into module-level docs.',
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Verify backticked relative file paths referenced in instruction files
      PATH_TOKEN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PATH_TOKEN_RE.exec(line)) !== null) {
        const candidate = match[1].replace(/^\.\//, '');
        // Skip URLs or obvious placeholders
        if (
          candidate.includes('://') ||
          candidate.includes('*') ||
          candidate.includes('<') ||
          candidate.startsWith('http')
        ) {
          continue;
        }
        // Only validate paths whose top-level folder exists in the repo (avoids flagging illustrative examples)
        const topDir = candidate.split('/')[0];
        const hasTopDir = ctx.files.some(
          (f) => f.relPath === topDir || f.relPath.startsWith(`${topDir}/`)
        );
        if (hasTopDir && !ctx.fileSet.has(candidate)) {
          findings.push({
            id: 'stale-instruction-path',
            category: 'instructions',
            severity: 'error',
            file: file.relPath,
            line: i + 1,
            message: `Referenced path \`${candidate}\` in ${file.relPath} does not exist.`,
            suggestion: `Update or remove \`${candidate}\` so coding agents do not chase stale paths.`,
          });
        }
      }

      // Verify `npm run <script>` commands against package.json
      if (pkgScripts) {
        NPM_SCRIPT_RE.lastIndex = 0;
        let scriptMatch: RegExpExecArray | null;
        while ((scriptMatch = NPM_SCRIPT_RE.exec(line)) !== null) {
          const scriptName = scriptMatch[1];
          if (!pkgScripts.has(scriptName)) {
            findings.push({
              id: 'stale-instruction-script',
              category: 'instructions',
              severity: 'error',
              file: file.relPath,
              line: i + 1,
              message: `Documented command \`npm run ${scriptName}\` is not defined in package.json.`,
              suggestion: `Add "${scriptName}" to package.json scripts or update ${path.posix.basename(file.relPath)}.`,
            });
          }
        }
      }
    }
  }

  return findings;
}
