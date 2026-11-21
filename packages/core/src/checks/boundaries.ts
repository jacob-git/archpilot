import type { CheckContext, Finding } from '../types.js';
import { buildImportGraph, detectCycles } from '../graph.js';

function matchesPrefix(target: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/\*$/, '').replace(/\/$/, '');
  return target === normalized || target.startsWith(`${normalized}/`);
}

export async function runBoundariesCheck(
  ctx: CheckContext,
  hasConfigFile: boolean
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const edges = await buildImportGraph(ctx.files, ctx.fileSet);

  // 1. Detect circular dependencies
  const cycles = detectCycles(edges);
  for (const cycle of cycles.slice(0, 10)) {
    findings.push({
      id: 'circular-dependency',
      category: 'architecture',
      severity: 'warning',
      file: cycle[0],
      line: 1,
      message: `Circular dependency detected: ${cycle.join(' -> ')}`,
      suggestion: 'Break the cycle by extracting shared types/contracts into a dedicated lower-level module.',
    });
  }

  // 2. Enforce declared boundary rules from archpilot.json
  if (ctx.config.boundaries.length === 0) {
    findings.push({
      id: 'no-boundary-rules',
      category: 'architecture',
      severity: 'info',
      message: hasConfigFile
        ? 'archpilot.json has no architecture boundary rules defined.'
        : 'No archpilot.json found; architectural boundary enforcement is inactive.',
      suggestion: 'Define `boundaries` in archpilot.json so AI agents cannot violate module/layer boundaries.',
    });
    return findings;
  }

  for (const edge of edges) {
    for (const rule of ctx.config.boundaries) {
      if (!matchesPrefix(edge.from, rule.from)) {
        continue;
      }
      for (const disallowed of rule.disallow) {
        const hitResolved = edge.resolved ? matchesPrefix(edge.resolved, disallowed) : false;
        const hitSpecifier =
          edge.specifier === disallowed || edge.specifier.startsWith(`${disallowed}/`);

        if (hitResolved || hitSpecifier) {
          const targetLabel = edge.resolved ?? edge.specifier;
          findings.push({
            id: 'boundary-violation',
            category: 'architecture',
            severity: 'error',
            file: edge.from,
            line: edge.line,
            message:
              rule.message ??
              `Boundary violation${rule.name ? ` (${rule.name})` : ''}: \`${edge.from}\` must not import \`${targetLabel}\`.`,
            suggestion: `Refactor \`${edge.from}\` to depend on an allowed interface or shared contract instead of \`${disallowed}\`.`,
          });
        }
      }
    }
  }

  return findings;
}
