import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  analyzeBlastRadius,
  analyzeMigration,
  analyzeOpenApiBreakingChanges,
  analyzeTokenBreakdown,
  auditRepository,
  buildArchitectureDiagram,
  compareAgainstBaseline,
  findOrphanFiles,
  findUnusedDependencies,
  generateArchMap,
  generateFixPrompt,
  generateMermaidDiagram,
  generateMigrationPlanMd,
  generatePrHandoffBrief,
  runDependencyAudit,
  saveArchitectureBaseline,
  suggestMigrationPlaybooks,
  type MigrationPlaybookId,
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
  {
    name: 'plan_migration',
    description:
      'Analyze upgrade or migration readiness (e.g. webpack-to-vite, spring-boot-3-to-4, cjs-to-esm, react-18-to-19, pydantic-v1-to-v2, or custom archpilot.json migration rules) and return dependency-ordered migration waves.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        playbook: {
          type: 'string',
          description:
            'Migration playbook ID (e.g. webpack-to-vite, spring-boot-3-to-4, cjs-to-esm, react-18-to-19, pydantic-v1-to-v2). Omit to auto-detect the best matching playbook.',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          description: 'Output format: json (default) or markdown (MIGRATION_PLAN.md).',
        },
      },
    },
  },
  {
    name: 'get_token_breakdown',
    description:
      'Identify the heaviest folders and files by estimated AI token count and $/read so agents can optimize context usage and update .aiignore.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        modelRatePerMillion: {
          type: 'number',
          description: 'Optional input token price in USD per 1M tokens (defaults to $3/1M).',
        },
      },
    },
  },
  {
    name: 'find_orphans',
    description:
      'Find unreachable/dead source files with zero inbound imports that waste AI agent tokens.',
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
    name: 'find_unused_deps',
    description:
      'Find declared runtime dependencies never imported in source across npm (package.json), Python (requirements.txt/pyproject.toml), Java (pom.xml/build.gradle), and Go (go.mod).',
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
    name: 'check_openapi_diff',
    description:
      'Compare modified OpenAPI/Swagger specs against git HEAD / main to detect breaking API changes (removed endpoints/methods/2xx responses, removed schema properties, newly required fields).',
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
    name: 'compare_baseline',
    description:
      'Compare current repository architecture against a saved .archpilot-baseline.json snapshot (or save a new baseline when save=true) to detect circular dependency, boundary, external-system, and security regressions.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        save: {
          type: 'boolean',
          description: 'If true, saves a new baseline snapshot instead of comparing.',
        },
      },
    },
  },
  {
    name: 'audit_dependencies',
    description:
      'Run a dependency CVE audit across detected ecosystems (npm with public registry fallback, Python pip-audit, Go govulncheck, Java Maven/Gradle).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository root path (defaults to current working directory).',
        },
        npmRegistry: {
          type: 'string',
          description: 'Optional custom npm registry URL for npm audit.',
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

  if (name === 'plan_migration') {
    let playbook = typeof args.playbook === 'string' && args.playbook.trim() ? args.playbook.trim() : '';
    if (!playbook) {
      const suggested = await suggestMigrationPlaybooks(repoPath);
      playbook = suggested[0]?.id ?? 'cjs-to-esm';
    }
    const plan = await analyzeMigration(repoPath, { playbookId: playbook as MigrationPlaybookId });
    const fmt = args.format === 'markdown' ? 'markdown' : 'json';
    return {
      content: [
        {
          type: 'text',
          text: fmt === 'markdown' ? generateMigrationPlanMd(plan) : JSON.stringify(plan, null, 2),
        },
      ],
    };
  }

  if (name === 'get_token_breakdown') {
    const rate = typeof args.modelRatePerMillion === 'number' && args.modelRatePerMillion > 0
      ? args.modelRatePerMillion
      : undefined;
    const breakdown = await analyzeTokenBreakdown(repoPath, rate);
    return {
      content: [{ type: 'text', text: JSON.stringify(breakdown, null, 2) }],
    };
  }

  if (name === 'find_orphans') {
    const report = await findOrphanFiles(repoPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }

  if (name === 'find_unused_deps') {
    const report = await findUnusedDependencies(repoPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }

  if (name === 'check_openapi_diff') {
    const report = await analyzeOpenApiBreakingChanges(repoPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }

  if (name === 'compare_baseline') {
    if (args.save === true) {
      const saved = await saveArchitectureBaseline(repoPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }],
      };
    }
    const diff = await compareAgainstBaseline(repoPath);
    return {
      content: [{ type: 'text', text: JSON.stringify(diff, null, 2) }],
    };
  }

  if (name === 'audit_dependencies') {
    const npmRegistry = typeof args.npmRegistry === 'string' && args.npmRegistry.trim()
      ? args.npmRegistry.trim()
      : undefined;
    const report = await runDependencyAudit(repoPath, { npmRegistry });
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
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
            serverInfo: { name: 'archpilot', version: '1.2.0' },
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
