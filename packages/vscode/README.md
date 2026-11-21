# ArchPilot for VS Code

Executable architecture guardrails and AI-readiness auditing for VS Code, Cursor, and Windsurf.

## Features

- **Agent Instructions Audit** — Validates `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and `.github/copilot-instructions.md`, flagging dead file paths and broken `npm run` scripts.
- **Architecture & Boundaries** — Enforces module/layer rules from `archpilot.json` and detects circular dependencies.
- **Context Hygiene** — Flags oversized files while respecting `.gitignore`, `.aiignore`, and `.cursorignore`.
- **Verifiability** — Checks automated test presence, runnable verification scripts, and TypeScript strictness.
- **1-Click Generators** — Generate `AGENTS.md` or initialize `archpilot.json` directly from the ArchPilot sidebar.
