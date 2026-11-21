# ArchPilot — Architecture, Security & AI Token Guardrails

**Keep your repositories clean, secure, token-efficient, and safe for AI coding agents — right inside VS Code, Cursor, and Windsurf.**

ArchPilot runs fast, **100% offline & deterministic** checks (zero API keys, zero MCP required) across **TypeScript, JavaScript, Java (Spring Boot), Python, Go, and Rust**.

---

## Key Features

### Interactive Architecture & Dependency Graph
- Visualize modules, circular dependencies (highlighted in red), boundary violations, and token-heavy folders right inside VS Code.
- Drag nodes, zoom/pan, and click any module to inspect files and dependencies side-by-side.

### AI Token Cost Estimator & 1-Click Savings
- Live **Token Cost** row per project showing estimated monthly cost/dev and potential savings, auto-detecting your live **VS Code / GitHub Copilot** models plus Fast / Standard / Reasoning / Frontier tiers.
- **Active File Token Counter** in the Status Bar so you know before attaching `@file` to chat if a file is huge.
- **1-Click `Reduce AI Token Cost (Exclude Large Files)`** writes unignored large files to both `.aiignore` and `.cursorignore`.
- **Compact Repo Map (`ARCHMAP.md`)** generator so coding agents locate modules in 1 read instead of 15 searches.

### Security Guardrails (AI-Era & Supply-Chain)
- Detects hardcoded secrets (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic, Google, Groq, Private Keys) and exposed `.env`/`.pem`/`.key` files.
- Catches SQL injection, command injection, `eval`/`new Function`, XSS (`innerHTML`/`dangerouslySetInnerHTML`), disabled TLS verification, and wildcard CORS with credentials.
- Detects **AI instruction-file poisoning** (hidden invisible/Bidi Unicode or `curl|sh` inside `AGENTS.md`/`.cursor/rules`) and prompt-injection sinks.
- **1-Click Deterministic Quick Fixes** for exposed secret files, poisoned instructions, and disabled TLS — plus **`Fix with AI Chat`** for complex refactors.

### Architecture, Stack & Git Diff Blast Radius
- **Smart Auto-Generated Boundaries (`archpilot.json`)** tailored to your repo's actual folders (`domain`/`ui`/`db`, `controller`/`service`/`repository`, `packages/core`).
- **Git Diff & Blast Radius** — Inspect changed files, direct & transitive downstream impacted files, and risk level before committing or merging.
- **Stack Packs** — Auto-detects Spring Boot, FastAPI, Express/NestJS, Go/Rust APIs, and AI/LLM SDKs (OpenAPI contracts, Spring Controller→Service→Repository, `@Valid`, LLM timeouts, `max_tokens`, LLM-in-loop).

---

## Works Everywhere (CLI, CI/CD & Optional MCP)

- **GitHub Actions, GitLab CI, Bitbucket Pipelines, Azure DevOps:**
  ```bash
  npx archpilot . --fail-under 80
  npx archpilot . --diff
  npx archpilot . --format sarif > archpilot.sarif
  npx archpilot . --format markdown
  ```
- **Opt-in MCP Server (`npx archpilot mcp`):** Exposes `audit_repo`, `check_boundaries`, `check_diff`, `get_arch_map`, and `get_fix_prompt` (100% optional — zero penalty in MCP-restricted environments).

---

## Privacy & Enterprise NFR Guarantee

- **100% Local & Air-Gapped:** Zero telemetry, zero external network calls, zero API keys required. Your source code never leaves your machine.
- **Fast on Large Repos:** Debounced, non-overlapping re-audits with `.gitignore` / `.aiignore` / `.cursorignore` awareness so VS Code stays snappy even in large monorepos.
- **NFR Guardrails Built In:** Flags outbound HTTP calls missing timeouts, swallowed `catch {}` errors, blocking `*FileSync` I/O in Node APIs, missing `/healthz` probes, flaky test sleeps, and untested blast-radius gaps.

---

## Links

- [GitHub Repository](https://github.com/jacob-git/archpilot)
- [Report an Issue](https://github.com/jacob-git/archpilot/issues)
