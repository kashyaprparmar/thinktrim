import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/index.js";
import { applyHostPlans, prepareHostPlans } from "../src/setup.js";
import { readRegularFile } from "../src/safe-files.js";

const hooks = vi.hoisted(() => ({
  afterStat: undefined as undefined | ((file: string) => Promise<void>),
  afterSync: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args);
      await hooks.afterStat?.(String(args[0]));
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await hooks.afterSync?.();
      };
      return handle;
    },
  };
});

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-file-race-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  hooks.afterStat = undefined;
  hooks.afterSync = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) {
      throw new Error("Unsafe cleanup path");
    }
    await rm(root, { recursive: true, force: true });
  }
});

function replaceAfterStat(target: string, replacement: string): void {
  hooks.afterStat = async (file) => {
    if (file !== target) return;
    hooks.afterStat = undefined;
    await rename(target, `${target}.original`);
    await writeFile(target, replacement);
  };
}

test("setup rejects a config replaced between inspection and open", async () => {
  const root = await fixture();
  const target = path.join(root, ".mcp.json");
  await writeFile(target, '{"mcpServers":{}}');
  replaceAfterStat(target, '{"mcpServers":{},"private":"replacement"}');
  await expect(prepareHostPlans(["claude"], "setup", root)).rejects.toThrow(/changed/i);
});

test("trace rejects a replaced file without emitting its contents", async () => {
  const root = await fixture();
  const directory = path.join(root, ".thinktrim", "traces");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "trace.json");
  await writeFile(target, '{"trace":1}');
  replaceAfterStat(target, '{"private":"replacement"}');
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(runCli(["trace", "--id", "trace", "--workspace", root])).rejects.toThrow(/changed/i);
  expect(output).not.toHaveBeenCalled();
});

test("setup rejects oversized configuration before parsing", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ value: "x".repeat(1024 * 1024) }));
  await expect(prepareHostPlans(["claude"], "setup", root)).rejects.toThrow(/limit/i);
});

test("setup preserves edits made while its temporary file is being written", async () => {
  const root = await fixture();
  const target = path.join(root, ".mcp.json");
  await writeFile(target, '{"mcpServers":{}}');
  const plans = await prepareHostPlans(["claude"], "setup", root);
  const edited = '{"mcpServers":{},"userEdit":true}';
  hooks.afterSync = async () => {
    hooks.afterSync = undefined;
    await writeFile(target, edited);
  };
  await expect(applyHostPlans(plans)).rejects.toThrow(/changed/i);
  expect(await readFile(target, "utf8")).toBe(edited);
});

test("setup rejects a tampered staging file and preserves the original", async () => {
  const root = await fixture();
  const target = path.join(root, ".mcp.json");
  const original = '{"mcpServers":{}}';
  await writeFile(target, original);
  const plans = await prepareHostPlans(["claude"], "setup", root);
  hooks.afterSync = async () => {
    hooks.afterSync = undefined;
    const staged = (await readdir(root)).find((file) => file.endsWith(".tmp"));
    expect(staged).toBeDefined();
    await writeFile(path.join(root, staged!), '{"injected":true}');
  };
  await expect(applyHostPlans(plans)).rejects.toThrow(/changed/i);
  expect(await readFile(target, "utf8")).toBe(original);
});

test("reads reject an ancestor replaced with another ordinary directory", async () => {
  const root = await fixture();
  const directory = path.join(root, "config");
  await mkdir(directory);
  const target = path.join(directory, "test.json");
  await writeFile(target, "{}");
  hooks.afterStat = async (file) => {
    if (file !== directory) return;
    hooks.afterStat = undefined;
    await rename(directory, `${directory}.original`);
    await mkdir(directory);
    await writeFile(target, '{"replacement":true}');
  };
  await expect(readRegularFile(target, 1024)).rejects.toThrow(/changed/i);
});

test("bounded reads accept the exact byte limit and reject an additional byte", async () => {
  const root = await fixture();
  const target = path.join(root, "boundary.txt");
  await writeFile(target, "é".repeat(32));
  expect((await readRegularFile(target, 64))?.text).toBe("é".repeat(32));
  await writeFile(target, "é".repeat(32) + "x");
  await expect(readRegularFile(target, 64)).rejects.toThrow(/limit/i);
});

test("index rejects an oversized existing manifest without changing it", async () => {
  const root = await fixture();
  await mkdir(path.join(root, ".thinktrim"));
  const target = path.join(root, ".thinktrim", "last-index.json");
  const original = JSON.stringify({ managedBy: "thinktrim", data: "x".repeat(64 * 1024) });
  await writeFile(target, original);
  await expect(runCli(["index", "--workspace", root])).rejects.toThrow(/limit/i);
  expect(await readFile(target, "utf8")).toBe(original);
});
