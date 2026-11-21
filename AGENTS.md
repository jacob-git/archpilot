# AGENTS.md — ArchPilot

## Overview
ArchPilot is a deterministic architecture guardrail and AI-readiness auditing engine distributed as a VS Code / Open VSX extension and CLI.

## Commands
- `npm run build` — Build `@archpilot/core`, `archpilot` CLI, and `archpilot-vscode` extension.
- `npm run test` — Run unit tests for `@archpilot/core`.
- `npm run typecheck` — Run TypeScript strict type checking across all workspaces.
- `npm run audit:self` — Run ArchPilot against this repository.

## Repository Layout
- `packages/core/src/audit.ts` — Core audit orchestrator and scoring engine (zero VS Code/CLI dependencies).
- `packages/cli/src/index.ts` — CLI entry point (`npx archpilot`).
- `packages/vscode/src/extension.ts` — VS Code & Open VSX extension wrapper.

## Architecture Guardrails
- `packages/core` must remain pure Node/TypeScript with **zero** dependencies on `vscode`, `packages/cli`, or `packages/vscode` (enforced by `archpilot.json`).
- Keep checks fast, deterministic, and offline-first (no required API keys).
- Always run `npm run build`, `npm run typecheck`, and `npm run test` before finishing changes.
