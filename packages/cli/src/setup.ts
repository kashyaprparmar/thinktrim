import * as TOML from "@iarna/toml";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { captureDirectories, checkDirectories, readRegularFile } from "./safe-files.js";

export type HostName = "claude" | "codex" | "cursor" | "vscode";
export type HostOperation = "setup" | "uninstall";

export interface ConfigPlan {
  readonly host: HostName | "workspace";
  readonly target: string;
  readonly action: "create" | "update" | "remove" | "unchanged";
  readonly content?: string;
  readonly previousContent: string | null;
  readonly mode: number;
}

export function hostNames(host: string): readonly HostName[] {
  if (host === "all") return ["claude", "codex", "cursor", "vscode"];
  if (host === "claude" || host === "codex" || host === "cursor" || host === "vscode") {
    return [host];
  }
  throw new TypeError(`Unknown host: ${host}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function readExisting(filePath: string): Promise<{ text: string; mode: number } | null> {
  return readRegularFile(filePath, 1024 * 1024);
}

async function assertSafeConfigDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing to use a non-regular configuration directory: ${directory}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function projectTarget(host: HostName, workspaceRoot: string): string {
  if (host === "claude") return path.join(workspaceRoot, ".mcp.json");
  if (host === "cursor") return path.join(workspaceRoot, ".cursor", "mcp.json");
  if (host === "vscode") return path.join(workspaceRoot, ".vscode", "mcp.json");
  return path.join(workspaceRoot, ".codex", "config.toml");
}

import { fileURLToPath } from "node:url";

function cliEntryPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

function expectedServer(host: HostName, workspaceRoot: string): Record<string, unknown> {
  const command = process.execPath;
  const args =
    host === "claude"
      ? [cliEntryPath(), "mcp", "--workspace", "${CLAUDE_PROJECT_DIR:-.}"]
      : host === "codex"
        ? [cliEntryPath(), "mcp", "--workspace", path.resolve(workspaceRoot)]
        : host === "cursor"
          ? [cliEntryPath(), "mcp", "--workspace", "${workspaceFolder}"]
          : [cliEntryPath(), "mcp"];
  if (host === "codex") return { command, args, cwd: path.resolve(workspaceRoot) };
  return host === "vscode" ? { type: "stdio", command, args } : { command, args };
}

function parseJsonRoot(text: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}; no configuration was changed`);
  }
  if (!isRecord(parsed)) throw new Error(`Expected a JSON object in ${filePath}`);
  return parsed;
}

async function planJsonHost(
  host: HostName,
  target: string,
  operation: HostOperation,
  workspaceRoot: string,
): Promise<ConfigPlan> {
  const existing = await readExisting(target);
  const root = existing ? parseJsonRoot(existing.text, target) : {};
  const section = host === "vscode" ? "servers" : "mcpServers";
  const entriesValue = root[section];
  if (entriesValue !== undefined && !isRecord(entriesValue)) {
    throw new Error(`Expected ${section} to be an object in ${target}`);
  }
  const entries = (entriesValue ?? {}) as Record<string, unknown>;
  const expected = expectedServer(host, workspaceRoot);
  const current = entries.thinktrim;

  if (operation === "setup") {
    if (current !== undefined) {
      if (!equalJson(current, expected)) {
        throw new Error(
          `The existing ThinkTrim MCP entry in ${target} differs from this installation; it was left unchanged`,
        );
      }
      return {
        host,
        target,
        action: "unchanged",
        previousContent: existing?.text ?? null,
        mode: existing?.mode ?? 0o600,
      };
    }
    const mergedEntries = { ...entries, thinktrim: expected };
    const result = { ...root, [section]: mergedEntries };
    const content = `${JSON.stringify(result, null, 2)}\n`;
    return {
      host,
      target,
      action: existing ? "update" : "create",
      content,
      previousContent: existing?.text ?? null,
      mode: existing?.mode ?? 0o600,
    };
  }

  if (current === undefined) {
    return {
      host,
      target,
      action: "unchanged",
      previousContent: existing?.text ?? null,
      mode: existing?.mode ?? 0o600,
    };
  }
  if (!equalJson(current, expected)) {
    throw new Error(`The ThinkTrim entry in ${target} has been customized; it was left unchanged`);
  }
  const remaining = Object.fromEntries(
    Object.entries(entries).filter(([name]) => name !== "thinktrim"),
  );
  const content = `${JSON.stringify({ ...root, [section]: remaining }, null, 2)}\n`;
  return {
    host,
    target,
    action: "update",
    content,
    previousContent: existing?.text ?? null,
    mode: existing?.mode ?? 0o600,
  };
}

function tomlStringify(value: Record<string, unknown>): string {
  return TOML.stringify(value as Parameters<typeof TOML.stringify>[0]);
}

async function planCodex(
  target: string,
  operation: HostOperation,
  workspaceRoot: string,
): Promise<ConfigPlan> {
  const host: HostName = "codex";
  const existing = await readExisting(target);
  let root: Record<string, unknown> = {};
  if (existing) {
    try {
      root = TOML.parse(existing.text) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid TOML in ${target}; no configuration was changed`);
    }
  }
  const sectionValue = root.mcp_servers;
  if (sectionValue !== undefined && !isRecord(sectionValue)) {
    throw new Error(`Expected [mcp_servers] to be a table in ${target}`);
  }
  const servers = (sectionValue ?? {}) as Record<string, unknown>;
  const expected = expectedServer(host, workspaceRoot);
  const current = servers.thinktrim;
  if (operation === "setup") {
    if (current !== undefined) {
      if (!equalJson(current, expected)) {
        throw new Error(
          `The existing ThinkTrim MCP entry in ${target} differs; it was left unchanged`,
        );
      }
      return {
        host,
        target,
        action: "unchanged",
        previousContent: existing?.text ?? null,
        mode: existing?.mode ?? 0o600,
      };
    }
    const content = tomlStringify({ ...root, mcp_servers: { ...servers, thinktrim: expected } });
    // Round-trip validation prevents emitting malformed or structurally changed TOML.
    const validated = TOML.parse(content) as Record<string, unknown>;
    const validatedServers = validated.mcp_servers;
    if (!isRecord(validatedServers) || !equalJson(validatedServers.thinktrim, expected)) {
      throw new Error(`Could not validate merged Codex configuration at ${target}`);
    }
    return {
      host,
      target,
      action: existing ? "update" : "create",
      content,
      previousContent: existing?.text ?? null,
      mode: existing?.mode ?? 0o600,
    };
  }

  if (current === undefined) {
    return {
      host,
      target,
      action: "unchanged",
      previousContent: existing?.text ?? null,
      mode: existing?.mode ?? 0o600,
    };
  }
  if (!equalJson(current, expected)) {
    throw new Error(`The ThinkTrim entry in ${target} has been customized; it was left unchanged`);
  }
  const remaining = Object.fromEntries(
    Object.entries(servers).filter(([name]) => name !== "thinktrim"),
  );
  const content = tomlStringify({ ...root, mcp_servers: remaining });
  TOML.parse(content);
  return {
    host,
    target,
    action: "update",
    content,
    previousContent: existing?.text ?? null,
    mode: existing?.mode ?? 0o600,
  };
}

export async function prepareHostPlans(
  hosts: readonly HostName[],
  operation: HostOperation,
  workspaceRoot = process.cwd(),
): Promise<readonly ConfigPlan[]> {
  return Promise.all(
    hosts.map((host) => {
      const target = projectTarget(host, workspaceRoot);
      return host === "codex"
        ? planCodex(target, operation, workspaceRoot)
        : planJsonHost(host, target, operation, workspaceRoot);
    }),
  );
}

async function applyPlan(plan: ConfigPlan): Promise<void> {
  if (plan.action === "unchanged" || plan.content === undefined) return;
  if (Buffer.byteLength(plan.content) > 1024 * 1024)
    throw new Error("Configuration exceeds size limit");
  const current = await readExisting(plan.target);
  if ((current?.text ?? null) !== plan.previousContent) {
    throw new Error(`Configuration changed during setup; refusing to overwrite ${plan.target}`);
  }
  await mkdir(path.dirname(plan.target), { recursive: true });
  await assertSafeConfigDirectory(path.dirname(plan.target));
  const directories = await captureDirectories(path.dirname(plan.target));
  const temporary = path.join(
    path.dirname(plan.target),
    `.${path.basename(plan.target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", plan.mode);
    await handle.writeFile(plan.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const latest = await readExisting(plan.target);
    if ((latest?.text ?? null) !== plan.previousContent) {
      throw new Error("Configuration changed during setup; refusing to overwrite");
    }
    const staged = await readRegularFile(temporary, 1024 * 1024);
    if (staged?.text !== plan.content)
      throw new Error("Temporary configuration changed during setup");
    await checkDirectories(directories);
    await rename(temporary, plan.target);
  } catch (error) {
    if (handle) await handle.close();
    // Never clean up through an ancestor that has been replaced.
    await checkDirectories(directories)
      .then(() => rm(temporary, { force: true }))
      .catch(() => undefined);
    throw error;
  }
}

export async function applyHostPlans(plans: readonly ConfigPlan[]): Promise<void> {
  // Prepare all requested hosts before writing any of them; each individual write is atomic.
  for (const plan of plans) await applyPlan(plan);
}

export function printPlans(plans: readonly ConfigPlan[], dryRun: boolean): void {
  for (const plan of plans) {
    const verb =
      plan.action === "unchanged" ? "unchanged" : dryRun ? `would ${plan.action}` : plan.action;
    process.stdout.write(`${plan.host}: ${verb} ${plan.target}\n`);
  }
}

export async function planInit(workspaceRoot = process.cwd()): Promise<ConfigPlan> {
  const target = path.join(workspaceRoot, ".thinktrim", "config.json");
  const existing = await readExisting(target);
  const root = existing ? parseJsonRoot(existing.text, target) : {};
  if (root.schemaVersion !== undefined && root.schemaVersion !== 1) {
    throw new Error(`Unsupported ThinkTrim config schema in ${target}`);
  }
  if (root.workspaceRoot !== undefined && typeof root.workspaceRoot !== "string") {
    throw new Error(`Invalid workspaceRoot in ${target}`);
  }
  if (root.routing !== undefined && !isRecord(root.routing)) {
    throw new Error(`Invalid routing configuration in ${target}`);
  }
  if (
    isRecord(root.routing) &&
    root.routing.mode !== undefined &&
    !["local", "remote", "auto"].includes(root.routing.mode as string)
  ) {
    throw new Error(`Invalid routing mode in ${target}`);
  }
  const content = `${JSON.stringify(
    {
      ...root,
      schemaVersion: 1,
      workspaceRoot: root.workspaceRoot ?? path.resolve(workspaceRoot),
      routing: isRecord(root.routing) ? root.routing : { mode: "local" },
    },
    null,
    2,
  )}\n`;
  if (existing?.text === content) {
    return {
      host: "workspace",
      target,
      action: "unchanged",
      previousContent: existing.text,
      mode: existing.mode,
    };
  }
  return {
    host: "workspace",
    target,
    action: existing ? "update" : "create",
    content,
    previousContent: existing?.text ?? null,
    mode: existing?.mode ?? 0o600,
  };
}

export async function applyInitPlan(plan: ConfigPlan): Promise<void> {
  await applyPlan(plan);
}

export async function validateManagedJson(target: string): Promise<boolean> {
  const existing = await readExisting(target);
  if (!existing) return false;
  parseJsonRoot(existing.text, target);
  return true;
}

export async function fileAgeMs(target: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(target)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
