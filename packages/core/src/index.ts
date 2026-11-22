export { auditRepository } from './audit.js';
export { analyzeBlastRadius } from './blastRadius.js';
export type { BlastRadiusReport } from './blastRadius.js';
export { generatePrHandoffBrief } from './prBrief.js';
export { parseNpmAuditJson, runDependencyAudit } from './depAudit.js';
export type {
  DependencyAuditOptions,
  DependencyAuditReport,
  DependencyVulnerability,
  DepSeverity,
} from './depAudit.js';
export { buildModuleGraph } from './graph.js';
export type { ModuleGraphData, ModuleGraphEdge, ModuleGraphNode } from './graph.js';
export {
  buildArchitectureDiagram,
  generateArchitectureMd,
  generateMermaidDiagram,
} from './diagrams.js';
export type {
  ArchitectureDiagramData,
  ExternalSystemKind,
  ExternalSystemNode,
} from './diagrams.js';
export { loadConfig, DEFAULT_CONFIG } from './config.js';
export {
  generateAgentsMd,
  generateArchMap,
  generateArchPilotConfig,
  generateFixPrompt,
  generateGitignore,
  generateReadmeBadge,
  generateSmartArchPilotConfig,
} from './generators.js';
export { formatHtmlReport, formatMarkdown, formatSarif } from './formatters.js';
export {
  analyzeMigration,
  generateMigrationPlanMd,
  generateMigrationWavePrompt,
  suggestMigrationPlaybooks,
} from './migrations.js';
export { findOrphanFiles } from './orphans.js';
export type { OrphanFileInfo, OrphanFilesReport } from './orphans.js';
export {
  BASELINE_FILENAME,
  compareAgainstBaseline,
  createArchitectureBaseline,
  saveArchitectureBaseline,
} from './baseline.js';
export type { ArchitectureBaseline, BaselineDiffReport } from './baseline.js';
export type {
  ArchPilotConfig,
  AuditOptions,
  AuditReport,
  AuditSummary,
  BoundaryRule,
  CategoryId,
  CategoryScore,
  DetectedLanguage,
  DetectedStack,
  Finding,
  MigrationBlocker,
  MigrationPlan,
  MigrationPlaybookId,
  MigrationPlaybookMeta,
  MigrationRuleConfig,
  MigrationWave,
  MigrationWaveFile,
  Severity,
  TokenCostEstimate,
  TokenFootprint,
  TokenSink,
} from './types.js';
