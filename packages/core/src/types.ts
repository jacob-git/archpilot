export type Severity = 'error' | 'warning' | 'info';

export type CategoryId =
  | 'instructions'
  | 'architecture'
  | 'security'
  | 'stack'
  | 'context'
  | 'verifiability';

export type DetectedLanguage =
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'python'
  | 'go'
  | 'rust';

export interface DetectedStack {
  languages: DetectedLanguage[];
  frameworks: string[];
  capabilities: Array<'rest-api' | 'ai-llm' | 'mcp'>;
}

export interface Finding {
  id: string;
  category: CategoryId;
  severity: Severity;
  message: string;
  suggestion?: string;
  /** Workspace-relative POSIX path, if applicable. */
  file?: string;
  /** 1-based line number, if applicable. */
  line?: number;
}

export interface CategoryScore {
  id: CategoryId;
  label: string;
  score: number;
  weight: number;
  findings: Finding[];
}

export interface AuditSummary {
  filesScanned: number;
  codeFiles: number;
  durationMs: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface TokenSink {
  file: string;
  estimatedTokens: number;
}

export interface TokenCostEstimate {
  modelLabel: string;
  inputPerMillionUsd: number;
  turnsPerMonth: number;
  alwaysOnMonthlyUsd: number;
  sinkMonthlyRiskUsd: number;
  potentialMonthlySavingsUsd: number;
}

export interface TokenFootprint {
  alwaysOnInstructionTokens: number;
  tokenSinks: TokenSink[];
  totalSinkTokens: number;
  costEstimate: TokenCostEstimate;
}

export interface AuditOptions {
  inputPerMillionUsd?: number;
  turnsPerMonth?: number;
  modelLabel?: string;
}

export interface AuditReport {
  rootDir: string;
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  detectedStack: DetectedStack;
  tokenFootprint: TokenFootprint;
  categories: CategoryScore[];
  findings: Finding[];
  summary: AuditSummary;
}

export interface BoundaryRule {
  name?: string;
  /** Glob-like path prefix or regex string matching importing files (POSIX). */
  from: string;
  /** Disallowed target path prefixes (POSIX) or package names. */
  disallow: string[];
  message?: string;
}

export interface MigrationRuleConfig {
  name: string;
  /** Disallowed import specifiers or path substrings (e.g. "legacy-auth-sdk", "javax.persistence"). */
  forbidImports?: string[];
  /** Disallowed regex patterns to search in source/config files (e.g. "process\\.env\\.REACT_APP_"). */
  forbidPatterns?: string[];
  /** Actionable guidance shown for each match. */
  suggestion?: string;
}

export interface ArchPilotConfig {
  maxFileLines: number;
  maxInstructionTokens: number;
  maxFileTokens: number;
  ignore: string[];
  boundaries: BoundaryRule[];
  migrations?: MigrationRuleConfig[];
}

export type MigrationPlaybookId =
  | 'webpack-to-vite'
  | 'spring-boot-3-to-4'
  | 'cjs-to-esm'
  | 'react-18-to-19'
  | 'pydantic-v1-to-v2'
  | 'custom';

export interface MigrationPlaybookMeta {
  id: MigrationPlaybookId;
  name: string;
  description: string;
  recommended: boolean;
  reason?: string;
  customRule?: MigrationRuleConfig;
}

export interface MigrationBlocker {
  file: string;
  line?: number;
  ruleId: string;
  severity: Severity;
  message: string;
  suggestion: string;
}

export interface MigrationWaveFile {
  file: string;
  dependentCount: number;
  blockerCount: number;
  blockers: MigrationBlocker[];
}

export interface MigrationWave {
  wave: number;
  label: string;
  description: string;
  files: MigrationWaveFile[];
}

export interface MigrationPlan {
  playbookId: MigrationPlaybookId;
  name: string;
  description: string;
  rootDir: string;
  totalBlockers: number;
  impactedFileCount: number;
  estimatedEffort: 'low' | 'medium' | 'high';
  blockers: MigrationBlocker[];
  waves: MigrationWave[];
}

export interface ScannedFile {
  /** Workspace-relative POSIX path. */
  relPath: string;
  absPath: string;
  ext: string;
  sizeBytes: number;
}

export interface CheckContext {
  rootDir: string;
  config: ArchPilotConfig;
  files: ScannedFile[];
  fileSet: Set<string>;
  packageJson?: Record<string, unknown>;
  detectedStack: DetectedStack;
}
