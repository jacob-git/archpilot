import path from 'node:path';
import { loadConfig } from './config.js';
import { scanWorkspace } from './scanner.js';

export interface FolderTokenUsage {
  folder: string;
  fileCount: number;
  estimatedTokens: number;
  percentOfRepo: number;
  costPerReadUsd: number;
}

export interface FileTokenUsage {
  file: string;
  sizeBytes: number;
  estimatedTokens: number;
  costPerReadUsd: number;
}

export interface TokenBreakdownReport {
  rootDir: string;
  totalFiles: number;
  totalTokens: number;
  inputPerMillionUsd: number;
  fullReadCostUsd: number;
  topFolders: FolderTokenUsage[];
  topFiles: FileTokenUsage[];
}

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.vsix', '.jar', '.class',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.sqlite', '.db',
]);

function bucketFolder(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 1) return '(root)';
  if (parts.length === 2) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

export async function analyzeTokenBreakdown(
  rootDir: string,
  inputPerMillionUsd = 3
): Promise<TokenBreakdownReport> {
  const { config } = await loadConfig(rootDir);
  const files = await scanWorkspace(rootDir, config.ignore);

  const folderMap = new Map<string, { fileCount: number; tokens: number }>();
  const fileUsages: FileTokenUsage[] = [];
  let totalTokens = 0;

  for (const file of files) {
    if (BINARY_EXTS.has(file.ext.toLowerCase())) continue;
    const tokens = Math.max(1, Math.ceil(file.sizeBytes / 4));
    totalTokens += tokens;

    const folder = bucketFolder(file.relPath);
    const prev = folderMap.get(folder) ?? { fileCount: 0, tokens: 0 };
    prev.fileCount += 1;
    prev.tokens += tokens;
    folderMap.set(folder, prev);

    fileUsages.push({
      file: file.relPath,
      sizeBytes: file.sizeBytes,
      estimatedTokens: tokens,
      costPerReadUsd: (tokens * inputPerMillionUsd) / 1_000_000,
    });
  }

  const topFolders: FolderTokenUsage[] = Array.from(folderMap.entries())
    .map(([folder, stats]) => ({
      folder,
      fileCount: stats.fileCount,
      estimatedTokens: stats.tokens,
      percentOfRepo: totalTokens > 0 ? Math.round((stats.tokens / totalTokens) * 1000) / 10 : 0,
      costPerReadUsd: (stats.tokens * inputPerMillionUsd) / 1_000_000,
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.folder.localeCompare(b.folder))
    .slice(0, 12);

  fileUsages.sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.file.localeCompare(b.file));

  return {
    rootDir: path.resolve(rootDir),
    totalFiles: fileUsages.length,
    totalTokens,
    inputPerMillionUsd,
    fullReadCostUsd: (totalTokens * inputPerMillionUsd) / 1_000_000,
    topFolders,
    topFiles: fileUsages.slice(0, 15),
  };
}
