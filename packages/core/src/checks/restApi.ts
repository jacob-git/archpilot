import { readFile } from 'node:fs/promises';
import type { CheckContext, Finding } from '../types.js';

const OPENAPI_FILE_RE = /(?:^|\/)(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/i;
const RPC_VERB_SEGMENT_RE =
  /\/(?:get|create|update|delete|remove|fetch|add|list|set)(?:[A-Z][a-zA-Z0-9]*|[_-][a-zA-Z0-9]+)/;

function findNonKebabSegment(routePath: string): string | undefined {
  const segments = routePath.split('/').filter(Boolean);
  for (const seg of segments) {
    // Skip path parameters like {orderId}, :orderId, <id>
    if (seg.startsWith('{') || seg.startsWith(':') || seg.startsWith('<')) continue;
    // Skip version prefixes like v1, v2
    if (/^v\d+$/i.test(seg)) continue;
    if (/[a-z][A-Z]/.test(seg) || seg.includes('_')) {
      return seg;
    }
  }
  return undefined;
}

export async function runRestApiBestPracticesCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  const hasSpringBoot = ctx.detectedStack.frameworks.includes('Spring Boot');

  // 1. Spectral-style OpenAPI / Swagger specification linting
  const specFiles = ctx.files.filter(
    (f) => OPENAPI_FILE_RE.test(f.relPath) && f.sizeBytes <= 500_000
  );

  await Promise.all(
    specFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }

      // Confirm this is actually an OpenAPI / Swagger document
      if (!/["']?(?:openapi|swagger)["']?\s*:/i.test(content)) {
        return;
      }

      const isOas3 = /["']?openapi["']?\s*:\s*["']?3\./i.test(content);
      const lines = content.split(/\r?\n/);

      // Spectral: info-description (check specifically inside the top-level `info` block)
      let hasInfoDescription = false;
      const infoStartIdx = lines.findIndex((l) => /^\s*["']?info["']?\s*:/.test(l));
      if (infoStartIdx !== -1) {
        const infoIndent = lines[infoStartIdx].search(/\S/);
        for (let i = infoStartIdx + 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim() || line.trimStart().startsWith('#')) continue;
          const indent = line.search(/\S/);
          if (indent <= infoIndent && !line.trimStart().startsWith('}')) break;
          if (/["']?description["']?\s*:/i.test(line)) {
            hasInfoDescription = true;
            break;
          }
        }
      }
      if (infoStartIdx !== -1 && !hasInfoDescription) {
        findings.push({
          id: 'oas-missing-info-description',
          category: 'stack',
          severity: 'info',
          file: file.relPath,
          line: infoStartIdx + 1,
          message: 'OpenAPI `info` block is missing a `description` (Spectral `info-description`).',
          suggestion: 'Add an `info.description` explaining the API purpose and domain boundaries.',
        });
      }

      // Spectral: oas3-api-servers
      if (isOas3 && !/["']?servers["']?\s*:/i.test(content)) {
        findings.push({
          id: 'oas-missing-servers',
          category: 'stack',
          severity: 'info',
          file: file.relPath,
          line: 1,
          message: 'OpenAPI 3 spec has no `servers` array defined (Spectral `oas3-api-servers`).',
          suggestion: 'Define `servers` with base URLs so clients and contract tests know target environments.',
        });
      }

      // Security schemes / auth contract
      if (!/["']?(?:securitySchemes|securityDefinitions|security)["']?\s*:/i.test(content)) {
        findings.push({
          id: 'oas-missing-security',
          category: 'stack',
          severity: 'warning',
          file: file.relPath,
          line: 1,
          message: 'OpenAPI spec defines no `securitySchemes` or `security` requirements.',
          suggestion: 'Declare authentication schemes (Bearer/OAuth2/API Key) explicitly in the API contract.',
        });
      }

      // Spectral: operation-operationId
      const hasOperations =
        /^\s*["']?(?:get|post|put|patch|delete)["']?\s*:/im.test(content);
      if (hasOperations && !/["']?operationId["']?\s*:/i.test(content)) {
        findings.push({
          id: 'oas-missing-operation-id',
          category: 'stack',
          severity: 'info',
          file: file.relPath,
          line: 1,
          message: 'OpenAPI operations are missing `operationId` (Spectral `operation-operationId`).',
          suggestion: 'Add unique `operationId` values for clean SDK generation, tracing, and AI tool mapping.',
        });
      }

      // Error responses contract (4xx / 5xx / default)
      const hasSuccessResp = /["']?20\d["']?\s*:/.test(content);
      const hasErrorResp = /["']?(?:4\d\d|5\d\d|default)["']?\s*:/.test(content);
      if (hasSuccessResp && !hasErrorResp) {
        findings.push({
          id: 'oas-missing-error-responses',
          category: 'stack',
          severity: 'warning',
          file: file.relPath,
          line: 1,
          message: 'OpenAPI spec documents success (`2xx`) responses without any `4xx`/`5xx` error responses.',
          suggestion: 'Document error responses (e.g., `400`, `401`, `404`, `500`) using a consistent error schema (RFC 9457 Problem Details).',
        });
      }

      // REST URI naming checks across declared paths
      for (let i = 0; i < lines.length; i++) {
        const pathMatch = /^\s*["']?(\/[a-zA-Z0-9_./{}:-]+)["']?\s*:/.exec(lines[i]);
        if (!pathMatch) continue;
        const routePath = pathMatch[1];

        if (RPC_VERB_SEGMENT_RE.test(routePath)) {
          findings.push({
            id: 'rest-uri-verb',
            category: 'stack',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: `REST path \`${routePath}\` contains an RPC verb: use noun-based resources with HTTP methods.`,
            suggestion: 'Rename to a plural noun resource (e.g., `GET /orders` instead of `GET /getOrders`).',
          });
        } else {
          const badSeg = findNonKebabSegment(routePath);
          if (badSeg) {
            findings.push({
              id: 'rest-uri-naming',
              category: 'stack',
              severity: 'info',
              file: file.relPath,
              line: i + 1,
              message: `REST path segment \`${badSeg}\` in \`${routePath}\` should use lowercase kebab-case.`,
              suggestion: 'Use lowercase hyphen-separated nouns (e.g., `/user-profiles` instead of `/userProfiles`).',
            });
          }
        }
      }
    })
  );

  // 2. Code-level REST URI & Spring Boot NFR checks
  const routeFiles = ctx.files.filter(
    (f) =>
      (f.ext === '.java' || f.ext === '.ts' || f.ext === '.js' || f.ext === '.py') &&
      !/(?:test|spec)/i.test(f.relPath) &&
      f.sizeBytes <= 250_000
  );

  await Promise.all(
    routeFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split(/\r?\n/);
      const isSpringController = file.ext === '.java' && /@(?:Rest)?Controller\b/.test(content);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Verbs in code-defined REST routes (Spring / Express / Fastify / FastAPI)
        const routeMatch =
          /(?:@(?:Get|Post|Put|Delete|Patch|Request)Mapping|\.(?:get|post|put|delete|patch))\s*\(\s*(?:value\s*=\s*)?['"](\/[^'"]+)['"]/.exec(
            line
          );
        if (routeMatch && RPC_VERB_SEGMENT_RE.test(routeMatch[1])) {
          findings.push({
            id: 'rest-route-verb',
            category: 'stack',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: `Route \`${routeMatch[1]}\` embeds an RPC verb: prefer noun-based REST endpoints.`,
            suggestion: 'Use HTTP verbs (`GET`, `POST`, `DELETE`) on plural resource nouns instead.',
          });
        }

        // Spring Boot NFRs
        if (hasSpringBoot && file.ext === '.java') {
          if (/\bnew\s+RestTemplate\s*\(\s*\)/.test(line)) {
            findings.push({
              id: 'spring-resttemplate-no-timeout',
              category: 'stack',
              severity: 'warning',
              file: file.relPath,
              line: i + 1,
              message: '`new RestTemplate()` created without connect/read timeouts: resilience risk.',
              suggestion: 'Build via `RestTemplateBuilder` or `RestClient` with explicit connect & read timeouts.',
            });
          }

          if (isSpringController && /\.findAll\s*\(\s*\)/.test(line)) {
            findings.push({
              id: 'spring-unbounded-findall',
              category: 'stack',
              severity: 'warning',
              file: file.relPath,
              line: i + 1,
              message: 'Unbounded `.findAll()` called inside a Spring Controller without `Pageable`.',
              suggestion: 'Accept `Pageable` and return `Page<T>` to prevent memory exhaustion on large tables.',
            });
          }

          if (/^\s*@Autowired\b/.test(line)) {
            const nextLine = lines[i + 1] ?? '';
            if (/^\s*(?:private|protected|public)?\s+[A-Z][\w<>]*\s+\w+\s*;/.test(nextLine)) {
              findings.push({
                id: 'spring-field-autowired',
                category: 'stack',
                severity: 'info',
                file: file.relPath,
                line: i + 1,
                message: 'Field `@Autowired` injection detected: prefer constructor injection.',
                suggestion: 'Use `private final` fields with constructor injection for easier unit testing.',
              });
            }
          }
        }
      }
    })
  );

  return findings;
}
