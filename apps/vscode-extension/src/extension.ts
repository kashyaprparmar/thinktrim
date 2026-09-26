import * as vscode from "vscode";
import { indexWorkspace } from "@thinktrim/repo-indexer";
import type { RepositoryIndex } from "@thinktrim/repo-indexer";
import { BackendConnection } from "./backend.js";
import { readConfiguration } from "./configuration.js";
import { registerThinkTrimCommands } from "./commands.js";
import { ExtensionMetrics } from "./metrics.js";
import { MetricsTreeProvider } from "./sidebar.js";

export class ThinkTrimRuntime implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel("ThinkTrim", { log: true });
  readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  readonly backend: BackendConnection;
  readonly metrics = new ExtensionMetrics();
  readonly metricsView: MetricsTreeProvider;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly indexes = new Map<string, RepositoryIndex>();
  private readonly indexJobs = new Map<string, Promise<RepositoryIndex>>();
  private readonly indexWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly indexRevisions = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.backend = new BackendConnection(context);
    this.metricsView = new MetricsTreeProvider(this.metrics, this.backend);
    this.statusBar.name = "ThinkTrim status";
    this.statusBar.command = "thinktrim.status";
    this.statusBar.show();
    this.refreshStatusBar();
    this.subscriptions.push(
      vscode.window.registerTreeDataProvider("thinktrim.metrics", this.metricsView),
      ...registerThinkTrimCommands(this),
    );
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("thinktrim")) {
          this.backend.reset();
          this.refreshStatusBar();
          this.metricsView.refresh();
          this.output.info("ThinkTrim configuration changed.");
        }
      }),
      context.secrets.onDidChange((event) => {
        if (event.key.startsWith("thinktrim.backend.apiKey.")) {
          this.backend.reset();
          this.refreshStatusBar();
          this.metricsView.refresh();
          this.output.info("ThinkTrim backend credentials changed.");
        }
      }),
    );
    this.output.info("ThinkTrim extension activated.");
  }

  refreshStatusBar(): void {
    const { backend } = readConfiguration();
    this.statusBar.text = `$(check) ThinkTrim: ${backend}`;
    this.statusBar.tooltip =
      backend === "deterministic"
        ? "Click to view ThinkTrim status. Context ranking is local and deterministic."
        : `Selected provider: ${backend}. Ranking remains local and deterministic; use ThinkTrim: Test Backend for a synthetic connection check.`;
  }

  async getIndex(root: string): Promise<RepositoryIndex> {
    const key = vscode.Uri.file(root).fsPath;
    const cached = this.indexes.get(key);
    if (cached) return cached;
    const existingJob = this.indexJobs.get(key);
    if (existingJob) return existingJob;

    if (!this.indexWatchers.has(key)) {
      const folder = vscode.workspace.workspaceFolders?.find(
        (candidate) => candidate.uri.fsPath === key,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder ?? key, "**/*"),
      );
      const invalidate = () => {
        this.indexRevisions.set(key, (this.indexRevisions.get(key) ?? 0) + 1);
        this.indexes.delete(key);
      };
      this.subscriptions.push(
        watcher,
        watcher.onDidCreate(invalidate),
        watcher.onDidChange(invalidate),
        watcher.onDidDelete(invalidate),
      );
      this.indexWatchers.set(key, watcher);
    }

    const job = (async () => {
      for (;;) {
        const revision = this.indexRevisions.get(key) ?? 0;
        const previous = this.indexes.get(key);
        const index = previous ? await previous.refresh() : await indexWorkspace(key);
        if (revision !== (this.indexRevisions.get(key) ?? 0)) continue;
        this.indexes.set(key, index);
        this.metrics.setCachedWorkspaceIndexes(this.indexes.size);
        return index;
      }
    })();
    this.indexJobs.set(key, job);
    try {
      return await job;
    } finally {
      if (this.indexJobs.get(key) === job) this.indexJobs.delete(key);
    }
  }

  clearCache(): void {
    this.backend.cache.clear();
    this.indexes.clear();
    for (const key of this.indexJobs.keys()) {
      this.indexRevisions.set(key, (this.indexRevisions.get(key) ?? 0) + 1);
    }
    this.metrics.setCachedWorkspaceIndexes(0);
    this.metricsView.refresh();
  }

  dispose(): void {
    for (const disposable of this.subscriptions) disposable.dispose();
    this.metricsView.dispose();
    this.statusBar.dispose();
    this.output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new ThinkTrimRuntime(context));
}
