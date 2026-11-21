# ArchPilot

**Executable architecture guardrails and AI-readiness auditing for VS Code, Cursor, Windsurf, MCP, and any CI/CD platform.**

ArchPilot runs fast, deterministic checks (zero API keys required, zero Git-host lock-in) across **TypeScript, JavaScript, Java (Spring Boot), Python, Go, and Rust**:

- **Agent Instructions Audit** — Validates `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and `.github/copilot-instructions.md` and catches dead file paths or broken `npm run` scripts.
- **Architecture & Boundaries** — Enforces module/layer rules from `archpilot.json` and detects circular dependencies across 6 languages.
- **Stack & API Guardrails** — Auto-detects Spring Boot, FastAPI, Express/NestJS, Go/Rust APIs, and AI/LLM SDKs; checks OpenAPI/API contracts, Spring Controller → Service → Repository boundaries, `@Valid` annotations, hardcoded API keys, and LLM timeouts.
- **Context Hygiene** — Flags oversized files while respecting `.gitignore`, `.aiignore`, `.cursorignore`, and `archpilot.json`.
- **Verifiability** — Checks automated test presence, runnable verification scripts, and TypeScript strictness.

---

## CLI Usage (Works on GitHub, GitLab, Bitbucket, Azure DevOps, or Local)

```bash
# Pretty terminal report
npx archpilot .

# Enforce minimum score in CI (exits 1 on errors or score < 80)
npx archpilot . --fail-under 80

# Output SARIF 2.1.0 (GitHub Code Scanning, GitLab, Azure DevOps, Bitbucket)
npx archpilot . --format sarif > archpilot.sarif

# Output Markdown (for PR/MR comments)
npx archpilot . --format markdown

# Initialize AGENTS.md and archpilot.json
npx archpilot --init
```

---

## MCP Server Mode (For AI Coding Agents)

Let Claude Code, Cursor, Codex, or Antigravity self-check architecture boundaries before finishing edits:

```json
{
  "mcpServers": {
    "archpilot": {
      "command": "npx",
      "args": ["-y", "archpilot", "mcp"]
    }
  }
}
```

Exposed MCP tools:
- `audit_repo` — Full architecture & AI-readiness audit.
- `check_boundaries` — Boundary & cycle check (optionally filtered to edited files).
- `get_fix_prompt` — Structured remediation checklist.

---

## CI/CD Snippets

### GitHub Actions
```yaml
- uses: jacob-git/archpilot@v0.1.0
  with:
    fail-under: "80"
```

### GitLab CI (`.gitlab-ci.yml`)
```yaml
archpilot:
  image: node:22
  script:
    - npx --yes archpilot . --fail-under 80 --format sarif > archpilot.sarif
  artifacts:
    paths: [archpilot.sarif]
```

### Bitbucket Pipelines (`bitbucket-pipelines.yml`)
```yaml
pipelines:
  pull-requests:
    "**":
      - step:
          name: ArchPilot Guardrails
          image: node:22
          script:
            - npx --yes archpilot . --fail-under 80
```

### Azure Pipelines (`azure-pipelines.yml`)
```yaml
- script: npx --yes archpilot . --fail-under 80 --format sarif > archpilot.sarif
  displayName: Run ArchPilot Guardrails
```

---

## Monorepo Structure

```text
packages/
  core/    # @archpilot/core — Pure TypeScript analysis engine
  cli/     # archpilot — CLI, CI runner & MCP stdio server
  vscode/  # archpilot-vscode — VS Code & Open VSX extension
```

## Local Development

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run audit:self
npm run package:vscode
```
