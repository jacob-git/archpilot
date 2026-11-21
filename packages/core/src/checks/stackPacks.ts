import { readFile } from 'node:fs/promises';
import type { CheckContext, Finding } from '../types.js';
import { CODE_EXTENSIONS } from '../scanner.js';

const API_CONTRACT_RE =
  /(?:^|\/)(?:openapi|swagger).*\.(?:ya?ml|json)$|\.(?:graphql|gql|proto)$/i;

export async function runStackPacksCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { detectedStack } = ctx;
  const hasRestApi = detectedStack.capabilities.includes('rest-api');
  const hasAiLlm = detectedStack.capabilities.includes('ai-llm');
  const hasSpringBoot = detectedStack.frameworks.includes('Spring Boot');
  const hasFastApi = detectedStack.frameworks.includes('FastAPI');

  // 1. REST API Contract Check (OpenAPI / Swagger / GraphQL / Protobuf / SpringDoc / FastAPI auto-OpenAPI)
  if (hasRestApi && !hasFastApi) {
    const hasSpecFile = ctx.files.some((f) => API_CONTRACT_RE.test(f.relPath));
    let hasSpringDoc = false;
    if (hasSpringBoot) {
      const manifests = ctx.files.filter(
        (f) => f.relPath.endsWith('pom.xml') || f.relPath.endsWith('build.gradle') || f.relPath.endsWith('build.gradle.kts')
      );
      for (const mf of manifests.slice(0, 3)) {
        try {
          const content = await readFile(mf.absPath, 'utf8');
          if (/springdoc|swagger/i.test(content)) {
            hasSpringDoc = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!hasSpecFile && !hasSpringDoc) {
      findings.push({
        id: 'missing-api-contract',
        category: 'stack',
        severity: 'warning',
        message: 'REST API detected without a machine-readable contract (OpenAPI, Swagger, GraphQL, or Protobuf).',
        suggestion: 'Add an openapi.yaml (or springdoc-openapi / swagger) so AI agents and consumers can verify API contracts.',
      });
    }
  }

  // 2. Spring Boot Architecture Guardrails (Java)
  if (hasSpringBoot) {
    const javaFiles = ctx.files.filter((f) => f.ext === '.java' && !f.relPath.includes('/test/'));
    await Promise.all(
      javaFiles.map(async (file) => {
        let content: string;
        try {
          content = await readFile(file.absPath, 'utf8');
        } catch {
          return;
        }
        const isController = /@(?:Rest)?Controller\b/.test(content);
        if (!isController) return;

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/^\s*import\s+.*Repository\s*;/.test(line)) {
            findings.push({
              id: 'spring-controller-imports-repository',
              category: 'stack',
              severity: 'warning',
              file: file.relPath,
              line: i + 1,
              message: 'Spring Controller imports a Repository directly, bypassing the Service layer.',
              suggestion: 'Route data access through a @Service class to preserve Controller -> Service -> Repository boundaries.',
            });
          }
          if (/@RequestBody\b/.test(line) && !/@Valid(?:ated)?\b/.test(line)) {
            findings.push({
              id: 'spring-missing-valid',
              category: 'stack',
              severity: 'warning',
              file: file.relPath,
              line: i + 1,
              message: '@RequestBody parameter is missing @Valid / @Validated bean validation.',
              suggestion: 'Annotate request DTOs with @Valid so invalid payloads fail fast at the API boundary.',
            });
          }
        }
      })
    );
  }

  // 3. AI/LLM SDK reliability & cost guardrails
  if (hasAiLlm) {
    const codeFiles = ctx.files.filter((f) => CODE_EXTENSIONS.has(f.ext));
    await Promise.all(
      codeFiles.map(async (file) => {
        if (file.sizeBytes > 250_000) return;
        let content: string;
        try {
          content = await readFile(file.absPath, 'utf8');
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // LLM client instantiation without timeout (TS/JS & Python)
          if (
            /\b(?:new\s+)?(?:OpenAI|Anthropic)\s*\(\s*(?:\{[^}]*\}|\s*)\)/.test(line) &&
            !/timeout/i.test(line)
          ) {
            findings.push({
              id: 'llm-missing-timeout',
              category: 'stack',
              severity: 'info',
              file: file.relPath,
              line: i + 1,
              message: 'LLM client instantiated without an explicit timeout.',
              suggestion: 'Configure an explicit `timeout` on LLM clients to prevent hung requests/agents.',
            });
          }

          // LLM API call missing max_tokens / max_output_tokens (prevents runaway output costs)
          if (
            /\.(?:chat\.completions|completions|messages|responses)\.create\s*\(/.test(line)
          ) {
            const callWindow = lines.slice(i, Math.min(lines.length, i + 12)).join('\n');
            if (!/\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxOutputTokens)\b/.test(callWindow)) {
              findings.push({
                id: 'llm-missing-max-tokens',
                category: 'stack',
                severity: 'warning',
                file: file.relPath,
                line: i + 1,
                message: 'LLM API call has no explicit `max_tokens` / `max_output_tokens` cap.',
                suggestion: 'Set an explicit token ceiling on LLM calls to prevent runaway generation costs.',
              });
            }

            // LLM call inside a loop without batching/rate limiting
            const prevWindow = lines.slice(Math.max(0, i - 8), i).join('\n');
            if (
              /\b(?:for|while)\s*\(|\bfor\s+\w+\s+in\b|\.(?:map|forEach)\s*\(/.test(prevWindow)
            ) {
              findings.push({
                id: 'llm-call-in-loop',
                category: 'stack',
                severity: 'warning',
                file: file.relPath,
                line: i + 1,
                message: 'LLM API call detected inside a loop — can cause unexpected token/cost spikes.',
                suggestion: 'Batch items, enforce a concurrency/cost cap, or cache repeated prompts outside the loop.',
              });
            }
          }
        }
      })
    );
  }

  // 4. Python / Go / Rust manifest & hygiene checks
  if (detectedStack.languages.includes('python') && !ctx.fileSet.has('pyproject.toml')) {
    findings.push({
      id: 'python-missing-pyproject',
      category: 'stack',
      severity: 'info',
      message: 'Python code detected without a pyproject.toml.',
      suggestion: 'Add pyproject.toml with pytest/ruff/mypy config for standardized agent tooling.',
    });
  }

  if (detectedStack.languages.includes('go') && !ctx.fileSet.has('go.mod')) {
    findings.push({
      id: 'go-missing-gomod',
      category: 'stack',
      severity: 'warning',
      message: 'Go source files detected without a go.mod file.',
      suggestion: 'Initialize Go modules (`go mod init`) for reproducible dependency resolution.',
    });
  }

  if (detectedStack.languages.includes('rust') && !ctx.fileSet.has('Cargo.toml')) {
    findings.push({
      id: 'rust-missing-cargo',
      category: 'stack',
      severity: 'warning',
      message: 'Rust source files detected without a Cargo.toml manifest.',
      suggestion: 'Ensure a Cargo.toml exists at the workspace root.',
    });
  }

  return findings;
}
