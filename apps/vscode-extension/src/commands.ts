import path from "node:path";
import { ContextRankingPolicy, generateCandidates } from "@thinktrim/context-ranker";
import type { CandidateMetadata } from "@thinktrim/context-ranker";
import type { RepositoryIndex } from "@thinktrim/repo-indexer";
import { LayaHTTPBackend } from "@thinktrim/providers";
import * as vscode from "vscode";
import { BackendConnection } from "./backend.js";
import { readConfiguration, type BackendChoice } from "./configuration.js";
import { ExtensionMetrics, estimatedTokens, sourceMetadataCharacters } from "./metrics.js";
import { safeLogPath, safeMarkdownPath } from "./safe-text.js";

export interface CommandRuntime {
  readonly backend: BackendConnection;
  readonly metrics: ExtensionMetrics;
  readonly output: vscode.LogOutputChannel;
  readonly metricsView: { refresh(): void };
  getIndex(root: string): Promise<RepositoryIndex>;
  clearCache(): void;
  refreshStatusBar(): void;
}

function activeWorkspaceRoot(): { root: string; relativeFile?: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  const folder = editor
    ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
    : vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return undefined;
  const relativeFile = editor
    ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replaceAll("\\", "/")
    : undefined;
  return { root: folder.uri.fsPath, ...(relativeFile ? { relativeFile } : {}) };
}

function metadataCharacterCount(candidates: readonly CandidateMetadata[]): number {
  return candidates.reduce((total, candidate) => total + candidate.description.length, 0);
}

async function rankCandidates(
  runtime: CommandRuntime,
  operation: "rank_context" | "analyze_selection",
  retrievalQuery: string,
  rankingTask: string,
): Promise<void> {
  const workspace = activeWorkspaceRoot();
  if (!workspace) {
    void vscode.window.showWarningMessage("Open a local workspace folder before using ThinkTrim.");
    return;
  }
  const started = performance.now();
  const indexStarted = performance.now();
  const index = await runtime.getIndex(workspace.root);
  const indexLatencyMs = performance.now() - indexStarted;
  const config = readConfiguration();
  const generated = generateCandidates(index, retrievalQuery, {
    maxCandidates: config.maxCandidates,
  });
  const ranking = await new ContextRankingPolicy().rank({
    task: rankingTask,
    candidates: generated.details,
    ...(workspace.relativeFile ? { changedFiles: [workspace.relativeFile] } : {}),
  });
  const visible = ranking.ranked.slice(0, 8);
  const detailById = new Map(generated.details.map((candidate) => [candidate.id, candidate]));
  const visibleDetails = visible.flatMap((candidate) => {
    const detail = detailById.get(candidate.id);
    return detail ? [detail] : [];
  });
  const shortlistChars = metadataCharacterCount(visibleDetails);
  const elapsedMs = performance.now() - started;
  runtime.metrics.recordRun({
    operation,
    workspaceRoot: workspace.root,
    indexedFiles: index.files.size,
    indexLatencyMs,
    candidateCount: generated.details.length,
    displayedCount: visible.length,
    sourceMetadataChars: sourceMetadataCharacters(index),
    shortlistMetadataChars: shortlistChars,
    elapsedMs,
    rankedPaths: visible.map((candidate) => candidate.path),
    ranking,
  });
  runtime.metricsView.refresh();

  const pathLines = visible.map((candidate, position) => {
    const relevance = Math.round(candidate.relevance * 100);
    return `${position + 1}. ${safeLogPath(candidate.path)} — ${relevance}% relevance signal`;
  });
  runtime.output.info(
    `Completed ${operation}: ${index.files.size} indexed files, ${generated.details.length} candidates, ${visible.length} displayed, ${Math.round(elapsedMs)} ms.`,
  );
  if (pathLines.length) {
    runtime.output.info(pathLines.join("\n"));
  }

  const message =
    visible.length === 0
      ? "ThinkTrim found no matching files. Broaden the query or inspect the repository manually."
      : `ThinkTrim ranked ${visible.length} of ${generated.details.length} candidates. Results are local deterministic relevance signals, not calibrated confidence.`;
  if (visible.length === 0 || ranking.metadata.ambiguousTask) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  runtime.refreshStatusBar();
}

async function commandRankContext(runtime: CommandRuntime): Promise<void> {
  const task = await vscode.window.showInputBox({
    title: "ThinkTrim: Rank Context",
    prompt: "Describe the code context you need",
    placeHolder: "For example: token refresh and session expiry",
    ignoreFocusOut: true,
    validateInput: (value) =>
      !value.trim()
        ? "Enter a task or search phrase."
        : value.length > 10_000
          ? "Keep the search phrase under 10,000 characters."
          : undefined,
  });
  if (!task) return;
  await rankCandidates(runtime, "rank_context", task, task);
}

async function commandAnalyzeSelection(runtime: CommandRuntime): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection).trim();
  const workspace = activeWorkspaceRoot();
  if (!editor || !selection || !workspace) {
    void vscode.window.showInformationMessage(
      "Select code in a local workspace file, then run ThinkTrim: Analyze Selection.",
    );
    return;
  }
  const localQuery = selection.slice(0, 10_000);
  const file = workspace.relativeFile ?? "the selected file";
  const task = `Find repository context relevant to selected code in ${file}.`;
  await rankCandidates(runtime, "analyze_selection", localQuery, task);
}

function commandStatus(runtime: CommandRuntime): void {
  const config = readConfiguration();
  const cache = runtime.backend.cache.stats;
  const run = runtime.metrics.lastRun;
  const reduction = run
    ? `${estimatedTokens(run.sourceMetadataChars)} to ${estimatedTokens(run.shortlistMetadataChars)} estimated metadata tokens`
    : "no ranking run yet";
  void vscode.window.showInformationMessage(
    `Backend: ${config.backend}; completed ranking runs: ${runtime.metrics.decisionCount}; selection analyses: ${runtime.metrics.analyzeSelectionCount}; core decision cache: ${cache.entries} entries (not used by deterministic ranking); latest context shortlist: ${reduction}. Frontier token savings are unavailable in VS Code.`,
  );
}

async function commandOpenTrace(runtime: CommandRuntime): Promise<void> {
  const run = runtime.metrics.lastRun;
  if (!run) {
    void vscode.window.showInformationMessage(
      "No ThinkTrim ranking trace is available in this session.",
    );
    return;
  }
  const reduction =
    run.sourceMetadataChars > 0
      ? Math.round((1 - run.shortlistMetadataChars / run.sourceMetadataChars) * 100)
      : 0;
  const content = [
    "# ThinkTrim session trace",
    "",
    `- Time: ${run.occurredAt}`,
    `- Operation: ${run.operation}`,
    `- Workspace: ${safeMarkdownPath(run.workspaceRoot)}`,
    `- Files indexed: ${run.indexedFiles}`,
    `- Candidates retrieved: ${run.candidateCount}`,
    `- Candidates displayed: ${run.displayedCount}`,
    `- Index latency: ${Math.round(run.indexLatencyMs)} ms (measured)`,
    `- Total latency: ${Math.round(run.elapsedMs)} ms (measured)`,
    `- Candidate metadata reduction: ${reduction}% (estimated; paths and compact descriptions only)`,
    `- Ranking strategy: ${run.ranking.metadata.strategy}`,
    `- Ranking reason: ${run.ranking.metadata.reasonCode}`,
    `- Ranking confidence: ${run.ranking.calibrated ? String(run.ranking.confidence) : "not calibrated"}`,
    "- Frontier token savings: unavailable; VS Code does not expose host token usage.",
    "",
    "## Ranked paths",
    "",
    ...run.rankedPaths.map((filePath, index) => `${index + 1}. ${safeMarkdownPath(filePath)}`),
    "",
    "This is a local session summary. It does not contain file contents or the search text.",
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function commandTestBackend(runtime: CommandRuntime): Promise<void> {
  const backend = readConfiguration().backend;
  if (backend === "jev") {
    const choice = await vscode.window.showWarningMessage(
      "Testing Jev sends a fixed synthetic request to OpenRouter and may incur provider charges. No workspace data is sent.",
      "Send test request",
      "Cancel",
    );
    if (choice !== "Send test request") return;
  }
  try {
    const result = await runtime.backend.test();
    runtime.output.info(
      `Backend test: ${result.backend}, ${result.health}, ${result.latencyMs ?? "n/a"} ms.`,
    );
    void vscode.window.showInformationMessage(
      `${result.message}${result.latencyMs === null ? "" : ` Measured latency: ${result.latencyMs} ms.`}`,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "connection_error";
    runtime.output.warn(`Backend test failed (${code}).`);
    void vscode.window.showErrorMessage(
      `ThinkTrim backend test failed (${code}). Check the ThinkTrim output channel.`,
    );
  }
}

async function commandConfigureBackend(runtime: CommandRuntime): Promise<void> {
  const selected = await vscode.window.showQuickPick<{
    label: string;
    description: string;
    value: BackendChoice;
  }>(
    [
      {
        label: "Deterministic",
        description: "Local ranking; no model calls",
        value: "deterministic",
      },
      {
        label: "Laya HTTP",
        description: "Loopback service; repository data stays local",
        value: "laya-http",
      },
      {
        label: "Jev",
        description: "OpenRouter; used by the synthetic connection test",
        value: "jev",
      },
    ],
    { title: "ThinkTrim: Configure Backend", placeHolder: "Choose a backend" },
  );
  if (!selected) return;

  let endpoint: string | undefined;
  if (selected.value === "laya-http") {
    const enteredEndpoint = await vscode.window.showInputBox({
      title: "Laya HTTP endpoint",
      value: readConfiguration().layaEndpoint,
      prompt: "Use a loopback HTTP(S) URL. The provider rejects non-loopback endpoints.",
      ignoreFocusOut: true,
    });
    if (!enteredEndpoint) return;
    endpoint = enteredEndpoint.trim();
    const previousKey = (await runtime.backend.getApiKey("laya-http")) ?? "";
    try {
      new LayaHTTPBackend({ endpoint, apiKey: previousKey });
    } catch {
      void vscode.window.showErrorMessage("Enter a valid loopback HTTP(S) Laya endpoint.");
      return;
    }
  }

  let apiKey: string | undefined;
  if (selected.value !== "deterministic") {
    const keyPrompt = await vscode.window.showInputBox({
      title: `${selected.label} API key`,
      prompt:
        selected.value === "jev"
          ? "Required. Stored in VS Code SecretStorage."
          : "Optional. Leave blank if the local service does not use authentication.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && (value.trim().length < 8 || value.length > 2048)
          ? "The key must be between 8 and 2048 characters."
          : undefined,
    });
    if (keyPrompt === undefined || (selected.value === "jev" && !keyPrompt.trim())) return;
    apiKey = keyPrompt.trim();
  }

  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  if (selected.value !== "deterministic" && apiKey) {
    await runtime.backend.saveApiKey(selected.value, apiKey);
  } else if (selected.value !== "deterministic") {
    await runtime.backend.clearApiKey(selected.value);
  }
  const config = vscode.workspace.getConfiguration("thinktrim");
  await config.update("backend", selected.value, target);
  if (endpoint) await config.update("laya.endpoint", endpoint, target);

  runtime.backend.reset();
  runtime.refreshStatusBar();
  runtime.metricsView.refresh();
  runtime.output.info(`Backend configured: ${selected.value}.`);
  void vscode.window.showInformationMessage(`ThinkTrim backend set to ${selected.value}.`);
}

function commandClearCache(runtime: CommandRuntime): void {
  runtime.clearCache();
  runtime.output.info("ThinkTrim decision and workspace index caches cleared.");
  void vscode.window.showInformationMessage(
    "ThinkTrim decision and workspace index caches cleared.",
  );
}

async function commandDoctor(runtime: CommandRuntime): Promise<void> {
  const workspace = activeWorkspaceRoot();
  const config = readConfiguration();
  const keyNeeded = config.backend === "jev";
  const apiKey = await runtime.backend.getApiKey(config.backend);
  const result = [
    "# ThinkTrim Doctor",
    "",
    `- Extension host: ${vscode.version}`,
    `- Node.js: ${process.version}`,
    `- Workspace: ${workspace ? safeMarkdownPath(workspace.root) : "not open (local folder required for indexing)"}`,
    `- Backend: ${config.backend}`,
    `- Backend credential: ${keyNeeded ? (apiKey ? "present in SecretStorage" : "missing from SecretStorage") : "not required"}`,
    "- Ranking mode: deterministic; providers are used only by the explicit synthetic connection test",
    `- Workspace index snapshots: ${runtime.metrics.cachedWorkspaceIndexes}`,
    `- Decision cache entries: ${runtime.backend.cache.stats.entries}`,
    "- Frontier context and token usage: not exposed by VS Code extension APIs",
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: result,
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function runSafely(runtime: CommandRuntime, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : error instanceof Error
          ? error.name
          : "unknown_error";
    runtime.output.error(`ThinkTrim command failed (${code}).`);
    void vscode.window.showErrorMessage(
      `ThinkTrim command failed (${code}). See the ThinkTrim output channel.`,
    );
  }
}

export function registerThinkTrimCommands(runtime: CommandRuntime): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("thinktrim.status", () => commandStatus(runtime)),
    vscode.commands.registerCommand("thinktrim.rankContext", () =>
      runSafely(runtime, () => commandRankContext(runtime)),
    ),
    vscode.commands.registerCommand("thinktrim.analyzeSelection", () =>
      runSafely(runtime, () => commandAnalyzeSelection(runtime)),
    ),
    vscode.commands.registerCommand("thinktrim.openTrace", () =>
      runSafely(runtime, () => commandOpenTrace(runtime)),
    ),
    vscode.commands.registerCommand("thinktrim.testBackend", () => commandTestBackend(runtime)),
    vscode.commands.registerCommand("thinktrim.configureBackend", () =>
      runSafely(runtime, () => commandConfigureBackend(runtime)),
    ),
    vscode.commands.registerCommand("thinktrim.clearCache", () => commandClearCache(runtime)),
    vscode.commands.registerCommand("thinktrim.doctor", () =>
      runSafely(runtime, () => commandDoctor(runtime)),
    ),
  ];
}
