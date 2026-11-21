# ArchPilot — Architecture, Security, QA & AI Token Guardrails

**Stop AI coding agents from burning tokens and rotting your architecture.**

Instant, **100% offline & deterministic** architecture guardrails, living diagrams, AI token-cost savings, security & CVE auditing, and 1-click PR/QA handoff briefs across **TypeScript, JavaScript, Java (Spring Boot), Python, Go, and Rust**.

> **Zero API keys required. Zero telemetry. Works in air-gapped & MCP-restricted enterprises.**

---

## What You Get in 1 Click

### 1. Living Architecture & External Systems Graph
- Interactive draggable/zoomable graph of your repo's modules plus auto-detected **External Systems** (PostgreSQL, MySQL, MongoDB, Redis, Kafka, AWS, Stripe, OpenAI, Anthropic, Gemini, MCP).
- **1-Click Export:** **Copy Mermaid**, **Export `ARCHITECTURE.md`**, and **Export SVG** right from the graph header.

### 2. 1-Click `PR & QA Handoff Brief`
- Right-click any project → **Generate PR & QA Handoff Brief** for a ready-to-paste Markdown summary (GitHub PR, GitLab MR, Bitbucket PR, or Jira):
  - **Change Risk badge** (`LOW` / `MEDIUM` / `HIGH`) & External Systems in blast radius
  - **Mini Mermaid Impact Map** (changed modules → downstream impacted modules)
  - **QA Regression Checklist** (exact tests to run + untested impacted files)
  - **Architecture, Security & NFR Gate**

### 3. AI Token Cost Estimator & 1-Click Savings
- Visible **Token Cost** row per project showing monthly \$/dev and potential savings, auto-detecting your live **VS Code / GitHub Copilot** models plus Fast / Standard / Reasoning / Frontier tiers.
- **Active File Token Counter** in the Status Bar warns before attaching huge files to AI chat.
- **1-Click `Reduce AI Token Cost (Exclude Large Files)`** syncs unignored large files into both `.aiignore` and `.cursorignore`.
- **Compact Repo Map (`ARCHMAP.md`)** generator so coding agents locate modules in 1 read.

### 4. Security Guardrails & Dependency CVE Auditor
- **Code & Supply-Chain Security:** Hardcoded secrets (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic, Google, Groq, Private Keys), exposed `.env`/`.pem`/`.key`, SQLi, command injection, `eval`/`new Function`, XSS, disabled TLS, wildcard CORS, and **AI instruction-file poisoning** (hidden invisible/Bidi Unicode or `curl|sh` inside `AGENTS.md`/`.cursor/rules`).
- **On-Demand Dependency CVE Audit:** Right-click any project → **Audit Dependency Vulnerabilities (CVEs)** with automatic fallback to `https://registry.npmjs.org` for corporate Artifactory/Nexus registries, plus **1-click `npm audit fix`** and **`Fix with AI Chat`**.
- **Inline `⌘.` Quick Fix Lightbulb** right on editor squiggles.

### 5. Multi-Language Architecture, REST/OpenAPI, NFR & QA Checks
- **6-Language Import Graph:** Circular dependencies & smart auto-generated `archpilot.json` boundaries for TS, JS, Java, Python, Go, and Rust.
- **Spectral-Style OpenAPI & REST Linting:** Checks `info.description`, `servers`, `securitySchemes`, `operationId`, `4xx`/`5xx` error responses, RPC verbs in URIs, and kebab-case paths.
- **Framework & NFR Guardrails:** Spring Boot (`@RestController`→`@Service`→`@Repository`, `@Valid`, `RestTemplate` timeouts, unbounded `.findAll()`, `@Autowired` fields), Next.js `'use client'` server leaks, FastAPI sync-in-async, HTTP timeouts, swallowed `catch {}`, blocking `*FileSync`, and missing `/healthz`.
- **QA & Executive Reports:** Flaky-test sleep detection, skipped tests, missing assertions, and **Export Executive Report (HTML)**.

---

## Privacy & Enterprise Guarantee

- **100% Local Core Analysis:** Zero telemetry, zero source code uploaded, zero API keys required.
- **CLI & Any CI/CD:** Same engine via `npx archpilot . --format sarif|markdown|html`, `--diff`, `--pr-brief`, `--diagram`, and opt-in `archpilot mcp`.

---

## Links

- [GitHub Repository](https://github.com/jacob-git/archpilot)
- [Report an Issue](https://github.com/jacob-git/archpilot/issues)
