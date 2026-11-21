import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckContext, Finding } from '../types.js';
import { CODE_EXTENSIONS } from '../scanner.js';

const SECRET_RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'Stripe Live Key', re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'OpenAI API Key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'Anthropic API Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'Groq API Key', re: /\bgsk_[A-Za-z0-9]{24,}\b/ },
  { name: 'Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

const SENSITIVE_FILE_RE =
  /(?:^|\/)(?:\.env(?:\.(?:local|prod|production|staging|dev))?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$/i;
const SAFE_ENV_RE = /\.(?:example|sample|template|dist)$/i;
const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|tests?\/|.*\.(?:test|spec)\.[a-z0-9]+|test_.*\.py|.*_test\.go)$/i;

const INSTRUCTION_FILE_RE =
  /^(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.github\/copilot-instructions\.md|\.cursor\/rules\/.*\.(?:md|mdc))$/;
// Invisible / bidirectional control characters commonly used in instruction-file poisoning
const HIDDEN_UNICODE_RE = /[\u200B-\u200D\u202A-\u202E\u2066-\u2069]/;
const PIPE_SHELL_RE = /\b(?:curl|wget)\s+[^\n|]+\|\s*(?:ba)?sh\b/i;

export async function runSecurityCheck(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. Check for exposed credential/env files not excluded by .gitignore
  for (const file of ctx.files) {
    if (SENSITIVE_FILE_RE.test(file.relPath) && !SAFE_ENV_RE.test(file.relPath)) {
      findings.push({
        id: 'exposed-secret-file',
        category: 'security',
        severity: 'error',
        file: file.relPath,
        line: 1,
        message: `Sensitive file \`${path.posix.basename(file.relPath)}\` is present and not excluded by .gitignore.`,
        suggestion: 'Add this file to .gitignore immediately and rotate any exposed credentials.',
      });
    }
  }

  // 2. Scan AI instruction files for hidden Unicode / curl-pipe-shell poisoning
  const instructionFiles = ctx.files.filter((f) => INSTRUCTION_FILE_RE.test(f.relPath));
  await Promise.all(
    instructionFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (HIDDEN_UNICODE_RE.test(line)) {
          findings.push({
            id: 'poisoned-agent-instructions',
            category: 'security',
            severity: 'error',
            file: file.relPath,
            line: i + 1,
            message: 'Hidden invisible/bidirectional Unicode characters detected in agent instruction file.',
            suggestion: 'Inspect and strip invisible Unicode characters to prevent prompt/instruction poisoning.',
          });
          break;
        }
        if (PIPE_SHELL_RE.test(line)) {
          findings.push({
            id: 'poisoned-agent-instructions',
            category: 'security',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: 'Remote pipe-to-shell command (`curl|sh` / `wget|bash`) found inside agent instructions.',
            suggestion: 'Replace remote shell piping with pinned, auditable package or script commands.',
          });
        }
      }
    })
  );

  // 3. Scan source files for secrets & high-signal vulnerability patterns
  const codeFiles = ctx.files.filter(
    (f) => CODE_EXTENSIONS.has(f.ext) && !TEST_FILE_RE.test(f.relPath) && f.sizeBytes <= 250_000
  );

  await Promise.all(
    codeFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(file.absPath, 'utf8');
      } catch {
        return;
      }

      // Skip security rule definition files that intentionally contain regex signatures
      if (content.includes('ARCHPILOT_SECURITY_RULES_FILE')) {
        return;
      }

      const lines = content.split(/\r?\n/);
      let hasWildcardCors = false;
      let hasCorsCredentials = false;
      let corsLine = 1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
          continue;
        }

        // Hardcoded secrets
        if (!/example|placeholder|your[-_]|dummy|fake|sample/i.test(line)) {
          for (const rule of SECRET_RULES) {
            if (rule.re.test(line)) {
              findings.push({
                id: 'hardcoded-secret',
                category: 'security',
                severity: 'error',
                file: file.relPath,
                line: i + 1,
                message: `Possible hardcoded ${rule.name} detected in source code.`,
                suggestion: 'Move secrets to environment variables or a secret manager and rotate the key.',
              });
              break;
            }
          }
        }

        // SQL injection via template/f-string interpolation
        if (
          /\.(?:query|execute)\s*\(\s*(?:`[^`]*\$\{|f['"][^'"]*\{)[^)]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(
            line
          ) ||
          /\.(?:query|execute)\s*\(\s*(?:`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|f['"][^'"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"]*\{)/i.test(
            line
          )
        ) {
          findings.push({
            id: 'sql-injection-risk',
            category: 'security',
            severity: 'error',
            file: file.relPath,
            line: i + 1,
            message: 'String interpolation detected inside a SQL query: potential SQL injection.',
            suggestion: 'Use parameterized queries / prepared statements instead of string interpolation.',
          });
        }

        // Command injection
        if (
          /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(line) ||
          /\bos\.system\s*\(/.test(line) ||
          /\bsubprocess\.[a-zA-Z_]+\([^)]*shell\s*=\s*True/.test(line)
        ) {
          findings.push({
            id: 'command-injection-risk',
            category: 'security',
            severity: 'error',
            file: file.relPath,
            line: i + 1,
            message: 'Shell command execution with dynamic input or `shell=True`: potential command injection.',
            suggestion: 'Use `execFile`/`spawn` (or `subprocess.run` with an argument array and `shell=False`).',
          });
        }

        // Dynamic code execution
        if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
          findings.push({
            id: 'unsafe-code-exec',
            category: 'security',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: 'Dynamic code execution (`eval` / `new Function`) detected.',
            suggestion: 'Replace dynamic evaluation with safe parsing or explicit dispatch logic.',
          });
        }

        // XSS sinks
        if (/\bdangerouslySetInnerHTML\b/.test(line) || /\.innerHTML\s*=/.test(line)) {
          findings.push({
            id: 'xss-risk',
            category: 'security',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: 'Direct HTML injection (`dangerouslySetInnerHTML` / `.innerHTML`) detected.',
            suggestion: 'Use safe text rendering or sanitize HTML with DOMPurify before rendering.',
          });
        }

        // Disabled TLS verification
        if (
          /\brejectUnauthorized\s*:\s*false\b/.test(line) ||
          /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(line) ||
          /\bverify\s*=\s*False\b/.test(line)
        ) {
          findings.push({
            id: 'insecure-tls',
            category: 'security',
            severity: 'error',
            file: file.relPath,
            line: i + 1,
            message: 'TLS certificate verification is disabled: vulnerable to MITM attacks.',
            suggestion: 'Keep TLS verification enabled and configure trusted CA certificates instead.',
          });
        }

        // Prompt injection sink: req.body/query directly inside system prompt
        if (
          /role\s*:\s*['"]system['"]/.test(line) &&
          /\breq\.(?:body|query|params)\b/.test(
            lines.slice(i, Math.min(lines.length, i + 4)).join(' ')
          )
        ) {
          findings.push({
            id: 'prompt-injection-sink',
            category: 'security',
            severity: 'warning',
            file: file.relPath,
            line: i + 1,
            message: 'User request input appears directly inside a `system` prompt: prompt injection risk.',
            suggestion: 'Keep system instructions static and pass untrusted user input only in `user` messages.',
          });
        }

        if (/origin\s*:\s*['"]\*['"]/.test(line)) {
          hasWildcardCors = true;
          corsLine = i + 1;
        }
        if (/credentials\s*:\s*true/.test(line)) {
          hasCorsCredentials = true;
        }
      }

      if (hasWildcardCors && hasCorsCredentials) {
        findings.push({
          id: 'insecure-cors',
          category: 'security',
          severity: 'warning',
          file: file.relPath,
          line: corsLine,
          message: 'Wildcard CORS (`origin: "*"`) combined with `credentials: true` detected.',
          suggestion: 'Use an explicit allowlist of trusted origins when credentials are enabled.',
        });
      }
    })
  );

  return findings;
}
// ARCHPILOT_SECURITY_RULES_FILE
