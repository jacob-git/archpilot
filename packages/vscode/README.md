# ArchPilot — Architecture Guardrails & AI-Readiness Auditor

**Keep your repositories clean, verifiable, and safe for AI coding agents — right inside VS Code, Cursor, and Windsurf.**

ArchPilot runs fast, **100% offline & deterministic** checks (zero API keys required) across **TypeScript, JavaScript, Java (Spring Boot), Python, Go, and Rust**.

---

## Why ArchPilot?

When AI coding agents (Copilot, Cursor, Claude Code, Codex, Antigravity) write more of your codebase, repositories drift faster. ArchPilot gives you instant visibility and **1-click fixes** before architectural debt compounds:

- **Agent Instructions Audit** — Scans `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and `.github/copilot-instructions.md`, flagging **broken file paths**, **dead `npm run` scripts**, and bloated docs.
- **Architecture & Boundaries (6 Languages)** — Detects **circular dependencies** and enforces custom module/layer rules in `archpilot.json` across TypeScript, JavaScript, Python, Java, Go, and Rust.
- **Stack & API Guardrails** — Auto-detects **Spring Boot, FastAPI, Express/NestJS, Go/Rust APIs, and AI/LLM SDKs** to catch:
  - Missing machine-readable API contracts (OpenAPI / Swagger / GraphQL / Protobuf)
  - Spring Boot `@RestController` directly importing a `*Repository` (bypassing `@Service`)
  - Missing `@Valid` on `@RequestBody` DTOs
  - Hardcoded OpenAI / Anthropic / Google / Groq API keys
  - LLM clients instantiated without explicit timeouts
- **Context Hygiene** — Flags oversized mega-files while respecting `.gitignore`, `.aiignore`, `.cursorignore`, and `archpilot.json`.
- **Verifiability** — Checks automated test presence, runnable verification scripts, and TypeScript `strict: true`.

---

## Right-Click to Fix (No API Keys Needed)

- **Right-click any project** in the ArchPilot sidebar:
  - **Auto-Fix Deterministic Issues** — Generates missing `AGENTS.md`, `archpilot.json`, or `.gitignore`.
  - **Copy Fix Prompt for AI Agent** — Copies a structured prompt with exact file paths and line numbers to paste straight into Copilot, Cursor, Claude Code, or Codex.
  - **Copy README Badge** — Copies a shields.io score badge for your `README.md`.
- **Right-click any finding:**
  - **Quick Fix** — Runs the deterministic fix for that rule.
  - **Ignore File in `archpilot.json`** — Silences intentional large data/seed files in one click.
  - **Copy Fix Prompt for AI Agent** — Copies a targeted fix prompt for that single issue.

---

## Multi-Root Workspaces, CLI, CI/CD & MCP

ArchPilot supports multi-root VS Code workspaces out of the box, and shares the exact same engine with:

- **CLI & Any CI/CD** (GitHub Actions, GitLab CI, Bitbucket Pipelines, Azure DevOps):
  ```bash
  npx archpilot . --fail-under 80
  npx archpilot . --format sarif > archpilot.sarif
  npx archpilot . --format markdown
  ```
- **MCP Server Mode** (`npx archpilot mcp`) — Exposes `audit_repo`, `check_boundaries`, and `get_fix_prompt` so AI coding agents can self-verify boundaries before finishing a task.

---

## Links

- [GitHub Repository](https://github.com/jacob-git/archpilot)
- [Report an Issue](https://github.com/jacob-git/archpilot/issues)
