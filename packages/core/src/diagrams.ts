import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildModuleGraph, type ModuleGraphData } from './graph.js';
import { CODE_EXTENSIONS, scanWorkspace } from './scanner.js';
import { detectStack } from './stack.js';
import type { DetectedStack } from './types.js';

export type ExternalSystemKind = 'database' | 'cache-queue' | 'ai-llm' | 'cloud-api';

export interface ExternalSystemNode {
  id: string;
  label: string;
  kind: ExternalSystemKind;
  usedByModules: string[];
}

export interface ArchitectureDiagramData {
  graph: ModuleGraphData;
  stack: DetectedStack;
  externalSystems: ExternalSystemNode[];
}

const EXTERNAL_SIGNATURES: Array<{
  id: string;
  label: string;
  kind: ExternalSystemKind;
  re: RegExp;
}> = [
  { id: 'ext_postgres', label: 'PostgreSQL', kind: 'database', re: /\b(?:pg|postgres|postgresql|psycopg2|jdbc:postgresql)\b/i },
  { id: 'ext_mysql', label: 'MySQL', kind: 'database', re: /\b(?:mysql2?|jdbc:mysql)\b/i },
  { id: 'ext_mongo', label: 'MongoDB', kind: 'database', re: /\b(?:mongoose|mongodb|pymongo)\b/i },
  { id: 'ext_sqlite', label: 'SQLite / D1', kind: 'database', re: /\b(?:better-sqlite3|sqlite3?|cloudflare:d1|D1Database)\b/i },
  { id: 'ext_prisma', label: 'Prisma ORM', kind: 'database', re: /\b@prisma\/client\b|\bPrismaClient\b/ },
  { id: 'ext_supabase', label: 'Supabase', kind: 'database', re: /\b@supabase\/supabase-js\b|\bsupabase\b/i },
  { id: 'ext_firebase', label: 'Firebase', kind: 'database', re: /\bfirebase(?:\/|-admin)\b/i },
  { id: 'ext_dynamodb', label: 'AWS DynamoDB', kind: 'database', re: /\b(?:@aws-sdk\/client-dynamodb|dynamodb)\b/i },
  { id: 'ext_redis', label: 'Redis', kind: 'cache-queue', re: /\b(?:ioredis|redis)\b/i },
  { id: 'ext_kafka', label: 'Apache Kafka', kind: 'cache-queue', re: /\b(?:kafkajs|spring-kafka|confluent-kafka)\b/i },
  { id: 'ext_rabbitmq', label: 'RabbitMQ', kind: 'cache-queue', re: /\b(?:amqplib|rabbitmq)\b/i },
  { id: 'ext_sqs', label: 'AWS SQS / SNS', kind: 'cache-queue', re: /\b(?:@aws-sdk\/client-sqs|@aws-sdk\/client-sns)\b/i },
  { id: 'ext_s3', label: 'AWS S3', kind: 'cloud-api', re: /\b@aws-sdk\/client-s3\b|\bs3Client\b/i },
  { id: 'ext_stripe', label: 'Stripe API', kind: 'cloud-api', re: /\bfrom\s+['"]stripe['"]|\bnew\s+Stripe\s*\(/ },
  { id: 'ext_openai', label: 'OpenAI API', kind: 'ai-llm', re: /\bfrom\s+['"]openai['"]|\bnew\s+OpenAI\s*\(|\bimport\s+openai\b/ },
  { id: 'ext_anthropic', label: 'Anthropic Claude', kind: 'ai-llm', re: /\b@anthropic-ai\/sdk\b|\bnew\s+Anthropic\s*\(|\bimport\s+anthropic\b/ },
  { id: 'ext_gemini', label: 'Google Gemini', kind: 'ai-llm', re: /\b@google\/genai\b|\b@google\/generative-ai\b|\bgoogle\.genai\b/ },
  { id: 'ext_mcp', label: 'MCP Protocol', kind: 'ai-llm', re: /\b@modelcontextprotocol\/sdk\b|\bfastmcp\b/ },
];

function moduleGroupForFile(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0];
  return '(root)';
}

function sanitizeMermaidId(raw: string): string {
  return 'm_' + raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function buildArchitectureDiagram(
  rootDir: string
): Promise<ArchitectureDiagramData> {
  const resolvedRoot = path.resolve(rootDir);
  const { config } = await loadConfig(resolvedRoot);
  const files = await scanWorkspace(resolvedRoot, config.ignore);
  const fileSet = new Set(files.map((f) => f.relPath));

  let packageJson: Record<string, unknown> | undefined;
  if (fileSet.has('package.json')) {
    try {
      packageJson = JSON.parse(
        await readFile(path.join(resolvedRoot, 'package.json'), 'utf8')
      ) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  const [graph, stack] = await Promise.all([
    buildModuleGraph(resolvedRoot),
    detectStack(resolvedRoot, files, fileSet, packageJson),
  ]);

  const keptMods = new Set(graph.nodes.map((n) => n.id));
  const extUsage = new Map<string, Set<string>>();
  const codeFiles = files.filter(
    (f) => CODE_EXTENSIONS.has(f.ext) && !/(?:test|spec)/i.test(f.relPath) && f.sizeBytes <= 250_000
  );

  await Promise.all(
    codeFiles.map(async (file) => {
      const modId = moduleGroupForFile(file.relPath);
      if (!keptMods.has(modId)) return;
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }
      // Skip ArchPilot's own signature definition files
      if (content.includes('ARCHPILOT_DIAGRAM_SIGNATURES_FILE') || content.includes('ARCHPILOT_SECURITY_RULES_FILE')) {
        return;
      }
      for (const sig of EXTERNAL_SIGNATURES) {
        if (sig.re.test(content)) {
          const set = extUsage.get(sig.id) ?? new Set<string>();
          set.add(modId);
          extUsage.set(sig.id, set);
        }
      }
    })
  );

  const externalSystems: ExternalSystemNode[] = [];
  for (const sig of EXTERNAL_SIGNATURES) {
    const mods = extUsage.get(sig.id);
    if (mods && mods.size > 0) {
      externalSystems.push({
        id: sig.id,
        label: sig.label,
        kind: sig.kind,
        usedByModules: Array.from(mods).sort(),
      });
    }
  }

  return { graph, stack, externalSystems };
}

export function generateMermaidDiagram(data: ArchitectureDiagramData): string {
  const lines: string[] = ['flowchart LR'];

  lines.push(`  subgraph repo["${data.graph.repoName} Modules"]`);
  for (const n of data.graph.nodes) {
    const id = sanitizeMermaidId(n.id);
    const label = `${n.label} (${n.fileCount} files)`;
    lines.push(`    ${id}["${label}"]`);
  }
  lines.push('  end');

  if (data.externalSystems.length > 0) {
    lines.push('  subgraph external["External Systems & Infrastructure"]');
    for (const ext of data.externalSystems) {
      const shape = ext.kind === 'database' ? `[("${ext.label}")]` : `(["${ext.label}"])`;
      lines.push(`    ${ext.id}${shape}`);
    }
    lines.push('  end');
  }

  for (const e of data.graph.edges) {
    const fromId = sanitizeMermaidId(e.from);
    const toId = sanitizeMermaidId(e.to);
    if (e.isViolation) {
      lines.push(`  ${fromId} -.->|"violation"| ${toId}`);
    } else if (e.isCycle) {
      lines.push(`  ${fromId} -.->|"cycle"| ${toId}`);
    } else {
      lines.push(`  ${fromId} --> ${toId}`);
    }
  }

  for (const ext of data.externalSystems) {
    for (const mod of ext.usedByModules) {
      lines.push(`  ${sanitizeMermaidId(mod)} --> ${ext.id}`);
    }
  }

  return lines.join('\n');
}

export async function generateArchitectureMd(rootDir: string): Promise<string> {
  const data = await buildArchitectureDiagram(rootDir);
  const mermaid = generateMermaidDiagram(data);
  const stackTags = [
    ...data.stack.languages,
    ...data.stack.frameworks,
    ...data.stack.capabilities,
  ];

  const lines: string[] = [
    `# ARCHITECTURE.md — ${data.graph.repoName}`,
    '',
    '> Living architecture diagram generated deterministically by [ArchPilot](https://github.com/jacob-git/archpilot).',
    '',
    `- **Detected Stack:** ${stackTags.length > 0 ? stackTags.join(' · ') : 'generic'}`,
    `- **Modules:** ${data.graph.nodes.length} · **Internal Links:** ${data.graph.edges.length} · **External Systems:** ${data.externalSystems.length}`,
    '',
    '## System & Module Diagram',
    '',
    '```mermaid',
    mermaid,
    '```',
  ];

  if (data.externalSystems.length > 0) {
    lines.push('', '## External Integrations', '', '| System | Category | Used By |', '| :--- | :--- | :--- |');
    for (const ext of data.externalSystems) {
      lines.push(`| ${ext.label} | ${ext.kind} | ${ext.usedByModules.map((m) => `\`${m}\``).join(', ')} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
// ARCHPILOT_DIAGRAM_SIGNATURES_FILE
