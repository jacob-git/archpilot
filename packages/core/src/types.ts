export type Severity = 'error' | 'warning' | 'info';

export type CategoryId =
  | 'instructions'
  | 'architecture'
  | 'context'
  | 'verifiability'
  | 'stack';

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

export interface ArchPilotConfig {
  maxFileLines: number;
  maxInstructionTokens: number;
  maxFileTokens: number;
  ignore: string[];
  boundaries: BoundaryRule[];
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
