import type { ContextRankingResult } from "@thinktrim/context-ranker";
import type { RepositoryIndex } from "@thinktrim/repo-indexer";

export interface ExtensionRunRecord {
  readonly operation: "rank_context" | "analyze_selection";
  readonly workspaceRoot: string;
  readonly indexedFiles: number;
  readonly indexLatencyMs: number;
  readonly candidateCount: number;
  readonly displayedCount: number;
  readonly sourceMetadataChars: number;
  readonly shortlistMetadataChars: number;
  readonly elapsedMs: number;
  readonly rankedPaths: readonly string[];
  readonly ranking: ContextRankingResult;
  readonly occurredAt: string;
}

export class ExtensionMetrics {
  private runs = 0;
  private selectionAnalyses = 0;
  private indexSnapshots = 0;
  private latest: ExtensionRunRecord | undefined;

  get decisionCount(): number {
    return this.runs;
  }

  get analyzeSelectionCount(): number {
    return this.selectionAnalyses;
  }

  get lastRun(): ExtensionRunRecord | undefined {
    return this.latest;
  }

  get cachedWorkspaceIndexes(): number {
    return this.indexSnapshots;
  }

  setCachedWorkspaceIndexes(count: number): void {
    this.indexSnapshots = Math.max(0, Math.floor(count));
  }

  recordRun(record: Omit<ExtensionRunRecord, "occurredAt">): void {
    this.runs += 1;
    if (record.operation === "analyze_selection") this.selectionAnalyses += 1;
    this.latest = { ...record, occurredAt: new Date().toISOString() };
  }
}

export function sourceMetadataCharacters(index: RepositoryIndex): number {
  let total = 0;
  for (const file of index.files.values()) total += file.path.length;
  return total;
}

export function estimatedTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / 4);
}
