import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexWorkspace } from "../src/index.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-index-test-"));
  roots.push(root);
  return root;
}
async function put(root: string, relative: string, body: string | Uint8Array): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unsafe fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

describe("repository indexer", () => {
  it("refreshes same-size edits even when modification time is preserved", async () => {
    const root = await fixture();
    const file = path.join(root, "entry.ts");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await put(root, "entry.ts", "export function before() {}\n");
    await utimes(file, timestamp, timestamp);
    const first = await indexWorkspace(root);
    await put(root, "entry.ts", "export function afterx() {}\n");
    await utimes(file, timestamp, timestamp);
    expect((await stat(file)).mtimeMs).toBe(first.getFile("entry.ts")?.mtimeMs);
    expect((await stat(file)).size).toBe(first.getFile("entry.ts")?.size);
    const second = await first.refresh();
    expect(second.searchSymbols("before")).toEqual([]);
    expect(second.searchSymbols("afterx")[0]?.item.filePath).toBe("entry.ts");
    expect(second.getFile("entry.ts")?.sha256).not.toBe(first.getFile("entry.ts")?.sha256);
    expect(second.stats.indexed).toBe(1);
    expect((await second.refresh()).stats.reused).toBe(1);
  });

  it("honors root and nested gitignore rules, hard exclusions, binary detection, and language metadata", async () => {
    const root = await fixture();
    await put(root, ".gitignore", "*.log\n!keep.log\nprivate/\n");
    await put(root, "keep.log", "retained text");
    await put(root, "drop.log", "ignored text");
    await put(root, "private/secret.ts", "export const secret = 1");
    await put(root, "node_modules/lib/index.ts", "export const packageFile = 1");
    await put(root, "build/bundle.ts", "export const generatedFile = 1");
    await put(root, "src/.gitignore", "*.tmp\n!keep.tmp\n");
    await put(root, "src/drop.tmp", "ignored nested");
    await put(root, "src/keep.tmp", "retained nested");
    await put(root, "src/main.ts", "export function findWidget() { return 1; }");
    await put(root, "src/binary.dat", Uint8Array.of(1, 0, 2, 3));
    await put(root, ".env.local", "OPENROUTER_API_KEY=private-token");
    await put(root, "src/private.pem", "private key text");
    const index = await indexWorkspace(root);
    expect([...index.files.keys()]).toContain("keep.log");
    expect([...index.files.keys()]).toContain("src/keep.tmp");
    expect(index.getFile("src/main.ts")?.language).toBe("typescript");
    expect(index.getFile("src/main.ts")?.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const excluded of [
      "drop.log",
      "private/secret.ts",
      "node_modules/lib/index.ts",
      "build/bundle.ts",
      "src/drop.tmp",
      "src/binary.dat",
      ".env.local",
      "src/private.pem",
    ]) {
      expect(index.files.has(excluded)).toBe(false);
    }
  });

  it("extracts symbols and imports, resolves local dependencies, and retrieves lexically", async () => {
    const root = await fixture();
    await put(root, "src/math.ts", "export function calculateWidget() { return 42; }\n");
    await put(
      root,
      "src/app.ts",
      "import { calculateWidget } from './math.js';\nexport class WidgetApp {}\n",
    );
    await put(root, "src/unrelated.ts", "export function sendEmail() {}\n");
    const index = await indexWorkspace(root);
    expect(index.searchFiles("calculate widget")[0]?.item.path).toBe("src/math.ts");
    expect(index.searchSymbols("WidgetApp")[0]?.item).toMatchObject({
      name: "WidgetApp",
      kind: "class",
      line: 2,
    });
    expect(index.getDependencies("src/app.ts")).toEqual(["src/math.ts"]);
    expect(index.getDependents("src/math.ts")).toEqual(["src/app.ts"]);
    expect(index.getFile("src/app.ts")?.imports[0]?.resolvedPath).toBe("src/math.ts");
    expect(index.searchFiles("nonexistentnonsense")).toEqual([]);
    expect(() => index.getDependencies("../outside.ts")).toThrow(RangeError);
    expect(() => index.searchFiles("test", { limit: 0 })).toThrow(RangeError);
  });

  it("refreshes changed files, removes deleted files, and relinks reused imports", async () => {
    const root = await fixture();
    await put(root, "src/app.ts", "import './new';\nexport function first() {}\n");
    await put(root, "src/old.ts", "export const old = 1;");
    const first = await indexWorkspace(root);
    await put(root, "src/new.ts", "export const newValue = 1;");
    await rm(path.join(root, "src/old.ts"));
    const second = await first.refresh();
    expect(second.stats.reused).toBeGreaterThanOrEqual(1);
    expect(second.stats.indexed).toBe(1);
    expect(second.stats.removed).toBe(1);
    expect(second.getDependencies("src/app.ts")).toEqual(["src/new.ts"]);
    expect(second.files.has("src/old.ts")).toBe(false);
    await put(root, "src/app.ts", "import './new';\nexport function renamedWidget() {}\n");
    const third = await second.refresh();
    expect(third.stats.indexed).toBe(1);
    expect(third.searchSymbols("renamedWidget")[0]?.item.filePath).toBe("src/app.ts");
    expect(third.searchSymbols("first")).toEqual([]);
  });

  it("rejects unsafe options, honors cancellation, and does not traverse symlinks", async () => {
    const root = await fixture();
    const outside = await fixture();
    await put(root, "ok.py", "def useful_helper():\n    return 1\n");
    await put(outside, "secret.py", "def sensitive(): pass\n");
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let fileLinkCreated = false;
    try {
      await symlink(path.join(outside, "secret.py"), path.join(root, "linked.py"), "file");
      fileLinkCreated = true;
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
    }
    const index = await indexWorkspace(root);
    expect(index.files.has("linked/secret.py")).toBe(false);
    if (fileLinkCreated) expect(index.files.has("linked.py")).toBe(false);
    expect(index.searchSymbols("useful helper")[0]?.item.filePath).toBe("ok.py");
    await expect(indexWorkspace(root, { maxFileBytes: 0 })).rejects.toThrow(RangeError);
    const controller = new AbortController();
    controller.abort();
    await expect(indexWorkspace(root, { signal: controller.signal })).rejects.toThrow();
    const laterAbort = new AbortController();
    const snapshot = await indexWorkspace(root, { signal: laterAbort.signal });
    laterAbort.abort();
    await expect(snapshot.refresh()).resolves.toBeDefined();
  });
});
