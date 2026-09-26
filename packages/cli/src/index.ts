import { spawnSync } from "node:child_process";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { indexWorkspace } from "@thinktrim/repo-indexer";
import {
  parseDecisionBackend,
  parseRemoteDataClasses,
  startThinkTrimMcpServer,
} from "@thinktrim/mcp";
import type { McpDecisionBackendConfig } from "@thinktrim/mcp";
import { readRegularFile } from "./safe-files.js";
import {
  applyHostPlans,
  applyInitPlan,
  fileAgeMs,
  hostNames,
  planInit,
  prepareHostPlans,
  printPlans,
  validateManagedJson,
} from "./setup.js";

interface CliOptions {
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly id?: string;
  readonly limit?: number;
  readonly workspaceRoot: string;
  readonly decisionBackend?: McpDecisionBackendConfig["backend"];
  readonly allowedRemoteData?: McpDecisionBackendConfig["allowedRemoteData"];
}

function parseOptions(args: readonly string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  let dryRun = false;
  let json = false;
  let id: string | undefined;
  let limit: number | undefined;
  let workspaceRoot = process.cwd();
  let decisionBackend: CliOptions["decisionBackend"];
  let allowedRemoteData: CliOptions["allowedRemoteData"];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--dry-run") dryRun = true;
    else if (value === "--json") json = true;
    else if (
      value === "--id" ||
      value === "--limit" ||
      value === "--workspace" ||
      value === "--decision-backend" ||
      value === "--allow-remote-data"
    ) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new TypeError(`${value} requires a value`);
      index += 1;
      if (value === "--id") id = next;
      else if (value === "--decision-backend") decisionBackend = parseDecisionBackend(next);
      else if (value === "--allow-remote-data") allowedRemoteData = parseRemoteDataClasses(next);
      else if (value === "--workspace") workspaceRoot = path.resolve(next);
      else {
        limit = Number(next);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new TypeError("--limit must be an integer between 1 and 1000");
        }
      }
    } else if (value?.startsWith("--")) {
      throw new TypeError(`Unknown option: ${value}`);
    } else if (value !== undefined) positional.push(value);
  }
  return {
    positional,
    options: {
      dryRun,
      json,
      workspaceRoot,
      ...(id === undefined ? {} : { id }),
      ...(limit === undefined ? {} : { limit }),
      ...(decisionBackend === undefined ? {} : { decisionBackend }),
      ...(allowedRemoteData === undefined ? {} : { allowedRemoteData }),
    },
  };
}

function emit(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function hasCommand(command: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function gitValue(cwd: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

async function commandInit(options: CliOptions): Promise<void> {
  const plan = await planInit(options.workspaceRoot);
  printPlans([plan], options.dryRun);
  if (!options.dryRun) await applyInitPlan(plan);
}

async function commandSetup(
  operation: "setup" | "uninstall",
  host: string | undefined,
  options: CliOptions,
): Promise<void> {
  if (!host)
    throw new TypeError(`${operation} requires a host: claude, codex, cursor, vscode, or all`);
  const names = hostNames(host);
  // Plan every target first, so setup all never partially writes after a parse/conflict failure.
  const plans = await prepareHostPlans(names, operation, options.workspaceRoot);
  printPlans(plans, options.dryRun);
  if (!options.dryRun) await applyHostPlans(plans);
}

async function commandIndex(options: CliOptions): Promise<void> {
  const index = await indexWorkspace(options.workspaceRoot);
  const state = gitValue(options.workspaceRoot, "rev-parse", "HEAD");
  const payload = {
    managedBy: "thinktrim",
    schemaVersion: 1,
    workspaceRoot: index.root,
    indexedAt: new Date().toISOString(),
    gitHead: state ?? null,
    stats: index.stats,
  };
  const target = path.join(options.workspaceRoot, ".thinktrim", "last-index.json");
  const previousContent = (await readRegularFile(target, 64 * 1024))?.text ?? null;
  try {
    const previous: unknown = previousContent === null ? null : JSON.parse(previousContent);
    if (
      previousContent !== null &&
      (typeof previous !== "object" ||
        previous === null ||
        (previous as { managedBy?: unknown }).managedBy !== "thinktrim")
    ) {
      throw new Error(`Refusing to replace an unrecognized index manifest at ${target}`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid index manifest at ${target}`, { cause: error });
    }
    throw error;
  }
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await applyInitPlan({
    host: "workspace",
    target,
    action:
      previousContent === content ? "unchanged" : previousContent === null ? "create" : "update",
    content,
    previousContent,
    mode: 0o600,
  });
  emit({ workspaceRoot: index.root, ...index.stats, manifest: target }, options.json);
}

async function commandStatus(options: CliOptions): Promise<void> {
  const root = options.workspaceRoot;
  const config = path.join(root, ".thinktrim", "config.json");
  const manifest = path.join(root, ".thinktrim", "last-index.json");
  const hostFiles = {
    claude: path.join(root, ".mcp.json"),
    codex: path.join(root, ".codex", "config.toml"),
    cursor: path.join(root, ".cursor", "mcp.json"),
    vscode: path.join(root, ".vscode", "mcp.json"),
  };
  const exists = async (file: string): Promise<boolean> => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  };
  const result = {
    workspaceRoot: path.resolve(root),
    gitHead: gitValue(root, "rev-parse", "--short", "HEAD") ?? null,
    initialized: await exists(config),
    lastIndexAgeMs: (await fileAgeMs(manifest)) ?? null,
    hostConfigFiles: Object.fromEntries(
      await Promise.all(
        Object.entries(hostFiles).map(async ([host, file]) => [host, await exists(file)] as const),
      ),
    ),
  };
  emit(result, options.json);
}

async function commandDoctor(options: CliOptions): Promise<number> {
  const commands = ["git", "claude", "codex", "cursor", "code", "python", "uv"];
  const available = Object.fromEntries(commands.map((command) => [command, hasCommand(command)]));
  let configValid = true;
  try {
    await validateManagedJson(path.join(options.workspaceRoot, ".thinktrim", "config.json"));
  } catch {
    configValid = false;
  }
  const result = {
    node: process.version,
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 20,
    workspaceRoot: path.resolve(options.workspaceRoot),
    gitRepository: Boolean(gitValue(options.workspaceRoot, "rev-parse", "--show-toplevel")),
    configValid,
    commands: available,
  };
  emit(result, options.json);
  return result.nodeSupported && result.gitRepository && configValid ? 0 : 1;
}

async function commandTrace(options: CliOptions): Promise<void> {
  const directory = path.join(options.workspaceRoot, ".thinktrim", "traces");
  const assertDirectory = async (target: string): Promise<void> => {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("Trace directory must be a real directory");
    }
  };
  if (options.id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.id)) throw new TypeError("Invalid trace ID");
    await assertDirectory(path.dirname(directory));
    await assertDirectory(directory);
    const file = path.join(directory, `${options.id}.json`);
    const data = await readRegularFile(file, 64 * 1024);
    if (!data) throw new Error("Trace file does not exist");
    emit(JSON.parse(data.text) as unknown, options.json);
    return;
  }
  try {
    await assertDirectory(path.dirname(directory));
    await assertDirectory(directory);
    const traces = (await readdir(directory)).filter((name) =>
      /^[A-Za-z0-9_-]{1,128}\.json$/.test(name),
    );
    emit({ directory, traces }, options.json);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      emit({ directory, traces: [], message: "No persisted traces are available." }, options.json);
      return;
    }
    throw error;
  }
}

async function commandBenchmark(options: CliOptions): Promise<void> {
  const index = await indexWorkspace(options.workspaceRoot);
  const queries = options.limit ?? 25;
  const query = "import function class error test";
  const started = performance.now();
  let hitCount = 0;
  for (let indexNumber = 0; indexNumber < queries; indexNumber += 1) {
    hitCount += index.searchFiles(query, { limit: 20 }).length;
  }
  const searchMs = performance.now() - started;
  emit(
    {
      benchmark: "workspace-index-search",
      measurement: "single-process deterministic baseline",
      index: index.stats,
      queryCount: queries,
      hitsAcrossQueries: hitCount,
      totalSearchMs: Math.round(searchMs * 100) / 100,
      averageSearchMs: Math.round((searchMs / queries) * 100) / 100,
    },
    options.json,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function usage(): string {
  return [
    "thinktrim init [--dry-run]",
    "thinktrim doctor [--json]",
    "thinktrim status [--json]",
    "thinktrim index [--workspace PATH] [--json]",
    "thinktrim mcp [--workspace PATH] [--decision-backend deterministic|jev] [--allow-remote-data task,paths,summaries]",
    "thinktrim trace [--id TRACE_ID] [--workspace PATH]",
    "thinktrim benchmark [--limit COUNT] [--workspace PATH] [--json]",
    "thinktrim setup <claude|codex|cursor|vscode|all> [--dry-run]",
    "thinktrim uninstall <claude|codex|cursor|vscode> [--dry-run]",
  ].join("\n");
}

export async function runCli(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    emit(usage(), false);
    return 0;
  }
  const { positional, options } = parseOptions(args);
  const [command, subcommand] = positional;
  if (!command || command === "--help" || command === "help") {
    emit(usage(), false);
    return 0;
  }
  switch (command) {
    case "init":
      await commandInit(options);
      return 0;
    case "doctor":
      return commandDoctor(options);
    case "status":
      await commandStatus(options);
      return 0;
    case "index":
      await commandIndex(options);
      return 0;
    case "mcp":
      if (options.allowedRemoteData && options.decisionBackend !== "jev") {
        throw new TypeError("--allow-remote-data requires --decision-backend jev");
      }
      await startThinkTrimMcpServer({
        workspaceRoot: options.workspaceRoot,
        ...(options.decisionBackend === undefined
          ? {}
          : {
              decisionBackend: {
                backend: options.decisionBackend,
                ...(options.allowedRemoteData === undefined
                  ? {}
                  : { allowedRemoteData: options.allowedRemoteData }),
              },
            }),
      });
      return 0;
    case "trace":
      await commandTrace(options);
      return 0;
    case "benchmark":
      await commandBenchmark(options);
      return 0;
    case "setup":
      await commandSetup("setup", subcommand, options);
      return 0;
    case "uninstall":
      if (subcommand === "all")
        throw new TypeError("uninstall all is not supported; name each host");
      await commandSetup("uninstall", subcommand, options);
      return 0;
    default:
      throw new TypeError(`Unknown command: ${command}\n\n${usage()}`);
  }
}

export { usage as cliUsage };
