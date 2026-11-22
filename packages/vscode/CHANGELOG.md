# Changelog

All notable changes to ArchPilot are documented in this file.

## [1.0.0]
- Added **OpenAPI Breaking-Change Diff** (`Audit > Check OpenAPI Breaking Changes` and `--api-diff`) to compare modified OpenAPI/Swagger YAML & JSON specs against `git HEAD` / `main` and catch removed endpoints, removed HTTP methods, removed 2xx responses, removed schema properties, and newly added `required` fields before merge.
- First stable `1.0.0` release of ArchPilot.

## [0.9.0]
- Added **Top Token Consumers Breakdown** (`Optimize > Inspect Token Breakdown` and `--tokens`) showing heaviest folders and files by estimated token count and `$/read`, with 1-click `.aiignore` exclusion.
- Added **Unused Dependencies Finder** (`Optimize > Find Unused Dependencies` and `--unused-deps`) to flag `package.json` runtime dependencies never imported in source, with 1-click `npm uninstall` and AI Chat review.
- Added **Orphan / Dead File Finder** (`Optimize > Find Orphan / Dead Files` and `--orphans`) to detect unreachable source files wasting AI agent tokens, with 1-click `.aiignore` exclusion and AI Chat cleanup review.
- Added **Architecture Baseline Snapshot & Diff** (`Audit > Compare Architecture Baseline`, `--save-baseline`, and `--compare-baseline`) to catch newly introduced circular dependencies, boundary breaks, external-system drift, and security regressions after refactors or upgrades.
- Added `CHANGELOG.md` for the VS Code Marketplace Changelog tab.

## [0.8.0]
- Added **Upgrade & Migration Readiness Planner** (`Audit > Plan Upgrade / Migration...`, `--migrate`, `--migrate-md`) with built-in playbooks (`Webpack -> Vite`, `Spring Boot 3 -> 4`, `CommonJS -> ESM`, `React 18 -> 19`, `Pydantic v1 -> v2`), dependency-ordered migration waves, and custom `migrations` guardrails in `archpilot.json`.
- Promoted **Reduce AI Token Cost (Exclude Large Files)** to the top of both the ArchPilot sidebar and File Explorer (`ArchPilot >`) right-click menus.
- Fixed File Explorer `ArchPilot >` URI handling and on-demand single-folder auditing.
- Added repo-aware **Update AGENTS.md** (merge with AI Chat preserving custom rules, replace fresh, or open).
- Renamed sidebar view title to **Workspace** (`ARCHPILOT: WORKSPACE`).

## [0.7.0]
- Reorganized repository right-click menus into value-ranked **Audit**, **Optimize**, and **Generate & Export** submenus.
- Added single-repository **Rescan Repository** command and **File Explorer** `ArchPilot >` context menu with automated menu parity tests.

## [0.6.0]
- Added progressive sidebar loading spinner (`Scanning X/Y repositories...`) for large multi-root workspaces.
- Cleaned up grade/score formatting and documentation copy.

## [0.5.0]
- Added **Dependency CVE Auditor** (`--dep-audit`) with automatic fallback to `https://registry.npmjs.org` for corporate Artifactory/Nexus registries, plus 1-click `npm audit fix` and AI Chat remediation.
- Added **1-Click PR & QA Handoff Brief** (`--pr-brief`) and **Living Architecture Diagrams** (`--diagram`, `--arch-md`, SVG export).
