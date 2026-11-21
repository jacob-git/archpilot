import path from 'node:path';
import { analyzeBlastRadius } from './blastRadius.js';
import { buildArchitectureDiagram } from './diagrams.js';

function moduleOf(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0];
  return '(root)';
}

function mermaidId(raw: string): string {
  return 'n_' + raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function generatePrHandoffBrief(
  rootDir: string,
  explicitChangedFiles?: string[]
): Promise<string> {
  const resolvedRoot = path.resolve(rootDir);
  const repoName = path.basename(resolvedRoot);

  const [br, diagram] = await Promise.all([
    analyzeBlastRadius(resolvedRoot, explicitChangedFiles),
    buildArchitectureDiagram(resolvedRoot),
  ]);

  if (br.changedFiles.length === 0) {
    return `## PR & QA Handoff Brief — \`${repoName}\`\n\nNo git changes detected on the current branch.\n`;
  }

  const changedModules = new Set(br.changedFiles.map(moduleOf));
  const downstreamModules = new Set(
    br.transitiveDependents.map(moduleOf).filter((m) => !changedModules.has(m))
  );
  const allImpactedModules = new Set([...changedModules, ...downstreamModules]);

  const touchedExternal = diagram.externalSystems.filter((ext) =>
    ext.usedByModules.some((m) => allImpactedModules.has(m))
  );

  const riskBadge =
    br.riskLevel === 'high'
      ? '🔴 HIGH'
      : br.riskLevel === 'medium'
        ? '🟡 MEDIUM'
        : '🟢 LOW';

  const lines: string[] = [
    `## PR & QA Handoff Brief — \`${repoName}\``,
    '',
    `**Change Risk:** ${riskBadge} · **Changed Files:** ${br.changedFiles.length} · **Downstream Impacted:** ${br.transitiveDependents.length} · **Untested Impacted:** ${br.untestedImpactedFiles.length}`,
  ];

  if (touchedExternal.length > 0) {
    lines.push(
      `**External Systems in Blast Radius:** ${touchedExternal.map((e) => `\`${e.label}\``).join(', ')}`
    );
  }

  // Mini Mermaid Impact Diagram (only changed -> downstream -> external)
  const relevantEdges = diagram.graph.edges.filter(
    (e) => allImpactedModules.has(e.from) && allImpactedModules.has(e.to)
  );
  if (allImpactedModules.size > 0) {
    lines.push('', '### Impact Map', '', '```mermaid', 'flowchart LR');
    for (const m of Array.from(changedModules).sort()) {
      lines.push(`  ${mermaidId(m)}["✏️ ${m} (changed)"]`);
    }
    for (const m of Array.from(downstreamModules).sort()) {
      lines.push(`  ${mermaidId(m)}["${m} (impacted)"]`);
    }
    for (const ext of touchedExternal) {
      const shape = ext.kind === 'database' ? `[("${ext.label}")]` : `(["${ext.label}"])`;
      lines.push(`  ${ext.id}${shape}`);
    }
    for (const e of relevantEdges) {
      lines.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`);
    }
    for (const ext of touchedExternal) {
      for (const m of ext.usedByModules) {
        if (allImpactedModules.has(m)) {
          lines.push(`  ${mermaidId(m)} --> ${ext.id}`);
        }
      }
    }
    lines.push('```');
  }

  // QA Regression Checklist
  lines.push('', '### QA Regression Checklist', '');
  if (br.impactedTestsToRun.length > 0) {
    for (const tf of br.impactedTestsToRun.slice(0, 15)) {
      lines.push(`- [ ] Run automated test suite: \`${tf}\``);
    }
  } else {
    lines.push('- [ ] No matching automated test suites mapped to changed files — run full regression suite.');
  }
  if (br.untestedImpactedFiles.length > 0) {
    lines.push(
      `- [ ] **Manual QA / Add Tests (${br.untestedImpactedFiles.length} untested impacted files):** ${br.untestedImpactedFiles
        .slice(0, 8)
        .map((f) => `\`${f}\``)
        .join(', ')}${br.untestedImpactedFiles.length > 8 ? ` (+${br.untestedImpactedFiles.length - 8} more)` : ''}`
    );
  }
  if (touchedExternal.length > 0) {
    lines.push(
      `- [ ] Verify integration behavior with: ${touchedExternal.map((e) => e.label).join(', ')}`
    );
  }

  // Architecture, Security & NFR Gate
  lines.push('', '### Architecture, Security & NFR Gate', '');
  if (br.diffFindings.length === 0) {
    lines.push('✅ **Passed** — 0 boundary violations, security findings, or NFR issues in changed files.');
  } else {
    const errors = br.diffFindings.filter((f) => f.severity === 'error').length;
    const warnings = br.diffFindings.filter((f) => f.severity === 'warning').length;
    lines.push(
      `${errors > 0 ? '🔴 **Action Required**' : '🟡 **Review Recommended**'} — ${errors} error(s), ${warnings} warning(s) in changed files:`
    );
    lines.push('');
    for (const f of br.diffFindings.slice(0, 15)) {
      const icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`- ${icon} **\`${f.id}\`** (\`${f.file ?? ''}${f.line ? `:${f.line}` : ''}\`) — ${f.message}`);
    }
  }

  // Changed files list (collapsible for clean PRs)
  lines.push(
    '',
    '<details>',
    `<summary>Changed Files (${br.changedFiles.length})</summary>`,
    '',
    ...br.changedFiles.slice(0, 40).map((f) => `- \`${f}\``),
    '</details>',
    '',
    '*Generated offline by [ArchPilot](https://marketplace.visualstudio.com/items?itemName=Pallattu.archpilot-studio)*',
    ''
  );

  return lines.join('\n');
}
