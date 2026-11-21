import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  analyzeBlastRadius,
  auditRepository,
  buildArchitectureDiagram,
  generateArchMap,
  generateFixPrompt,
  generateMermaidDiagram,
  generatePrHandoffBrief,
} from '@archpilot/core';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'audit_repo',
    description:
      'Run a full ArchPilot architecture and AI-readiness audit on a local repository path. Returns score, detected stack, category breakdown, and all findings.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the repository root (defaults to current working directory).',
        },
      },
    },
  },
  {
    name: 'check_boundaries',
    description:
      'Check architecture boundary violations and circular dependencies for a repository, optionally filtered to specific edited file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of repo-relative file paths to filter boundary/cycle findings.',
        },
      },
    },
  },
  {
    name: 'get_fix_prompt',
    description:
      'Generate a structured remediation checklist for all ArchPilot findings in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
      },
    },
  },
  {
    name: 'get_arch_map',
    description:
      'Generate a compact architecture index (modules, entry points, most-imported hubs, boundaries) so an AI agent can locate code without scanning the whole repo.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
      },
    },
  },
  {
    name: 'check_diff',
    description:
      'Analyze git changed files (or an explicit file list) to report downstream blast radius, impacted modules, risk level, and findings in those files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of repo-relative file paths to analyze.',
        },
      },
    },
  },
  {
    name: 'get_architecture_diagram',
    description:
      'Generate a living Mermaid flowchart diagram showing internal modules, dependencies, violations, and detected external systems (DBs, queues, cloud, AI APIs).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
      },
    },
  },
  {
    name: 'generate_pr_brief',
    description:
      'Generate a ready-to-paste PR & QA Handoff Brief (Markdown) with change risk, mini Mermaid impact map, QA regression checklist, and security/architecture gate.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
      },
    },
  },
];

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const repoPath = path.resolve(typeof args.path === 'string' && args.path ? args.path : '.');

  if (name === 'audit_repo') {
    const report = await auditRepository(repoPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }

  if (name === 'check_boundaries') {
    const report = await auditRepository(repoPath);
    const filterFiles = Array.isArray(args.files)
      ? new Set(args.files.filter((x): x is string => typeof x === 'string'))
      : undefined;

    const archFindings = report.findings.filter((f) => {
      if (f.category !== 'architecture' && f.id !== 'spring-controller-imports-repository') {
        return false;
      }
      if (filterFiles && filterFiles.size > 0 && f.file) {
        return filterFiles.has(f.file);
      }
      return true;
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              rootDir: report.rootDir,
              passed: archFindings.every((f) => f.severity !== 'error'),
              violationCount: archFindings.length,
              findings: archFindings,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'get_fix_prompt') {
    const report = await auditRepository(repoPath);
    return {
      content: [{ type: 'text', text: generateFixPrompt(report) }],
    };
  }

  if (name === 'get_arch_map') {
    const map = await generateArchMap(repoPath);
    return {
      content: [{ type: 'text', text: map }],
    };
  }

  if (name === 'check_diff') {
    const files = Array.isArray(args.files)
      ? args.files.filter((x): x is string => typeof x === 'string')
      : undefined;
    const br = await analyzeBlastRadius(repoPath, files);
    return {
      content: [{ type: 'text', text: JSON.stringify(br, null, 2) }],
    };
  }

  if (name === 'get_architecture_diagram') {
    const data = await buildArchitectureDiagram(repoPath);
    return {
      content: [{ type: 'text', text: generateMermaidDiagram(data) }],
    };
  }

  if (name === 'generate_pr_brief') {
    const brief = await generatePrHandoffBrief(repoPath);
    return {
      content: [{ type: 'text', text: brief }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
}

export async function runMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }

    // Notifications (no id) require no response
    if (req.id === undefined) {
      continue;
    }

    try {
      if (req.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'archpilot', version: '0.1.0' },
          },
        });
      } else if (req.method === 'ping') {
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      } else if (req.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      } else if (req.method === 'tools/call') {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const toolArgs =
          typeof params.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        const result = await handleToolCall(name, toolArgs);
        send({ jsonrpc: '2.0', id: req.id, result });
      } else {
        send({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
