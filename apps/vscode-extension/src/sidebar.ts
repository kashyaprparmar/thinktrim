import * as vscode from "vscode";
import { readConfiguration } from "./configuration.js";
import { estimatedTokens, ExtensionMetrics } from "./metrics.js";
import { BackendConnection } from "./backend.js";

class MetricRow extends vscode.TreeItem {
  constructor(label: string, detail: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    if (tooltip) this.tooltip = tooltip;
    this.contextValue = "thinktrim.metric";
  }
}

export class MetricsTreeProvider implements vscode.TreeDataProvider<MetricRow> {
  private readonly changed = new vscode.EventEmitter<MetricRow | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly metrics: ExtensionMetrics,
    private readonly backend: BackendConnection,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: MetricRow): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<MetricRow[]> {
    const config = readConfiguration();
    const run = this.metrics.lastRun;
    const cache = this.backend.cache.stats;
    const rankingEstimate = run
      ? `${run.indexedFiles} indexed paths → ${run.displayedCount} candidate descriptions; ~${estimatedTokens(run.sourceMetadataChars)} → ~${estimatedTokens(run.shortlistMetadataChars)} metadata tokens`
      : "No ranking run yet";
    const reduction = run
      ? run.sourceMetadataChars > 0
        ? `${Math.round((1 - run.shortlistMetadataChars / run.sourceMetadataChars) * 100)}% estimated metadata reduction`
        : "0% estimated metadata reduction"
      : "Not available yet";
    const usage = run?.ranking.metadata.usage;
    const backendTokens = usage
      ? `${usage.unit}: ${usage.inputUnits ?? 0} input / ${usage.outputUnits ?? 0} output (measured)`
      : "Not reported by the last ranking (measured)";
    const latency = run
      ? `${Math.round(run.elapsedMs)} ms total; ${Math.round(run.indexLatencyMs)} ms indexing (measured)`
      : "Not available yet";

    return [
      new MetricRow("Backend", `${config.backend} · ranking remains deterministic`),
      new MetricRow("Ranking runs", `${this.metrics.decisionCount} this session (measured)`),
      new MetricRow(
        "Selection analyses",
        `${this.metrics.analyzeSelectionCount} this session (measured)`,
      ),
      new MetricRow("Escalations", "Not tracked · no VS Code frontier handoff API"),
      new MetricRow(
        "Cache",
        `${this.metrics.cachedWorkspaceIndexes} workspace indexes · ${cache.entries} decision entries`,
        `${cache.hits} decision hits and ${cache.misses} misses. Deterministic ranking does not use the decision cache.`,
      ),
      new MetricRow("Context reduction", reduction, rankingEstimate),
      new MetricRow("Latency", latency),
      new MetricRow(
        "Backend token usage",
        usage ? backendTokens : "Not reported by the last ranking (unknown)",
      ),
      new MetricRow(
        "Frontier token savings",
        "Unavailable · VS Code does not expose host token usage",
      ),
      new MetricRow(
        "Candidate token estimate",
        run
          ? `${estimatedTokens(run.shortlistMetadataChars)} tokens at ~4 characters/token (estimated)`
          : "Not available yet",
      ),
    ];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
