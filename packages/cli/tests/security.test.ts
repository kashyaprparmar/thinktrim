import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../src/index.js";
import { prepareHostPlans } from "../src/setup.js";

test("setup refuses a symlinked host configuration directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-cli-security-"));
  const outside = await mkdtemp(path.join(tmpdir(), "thinktrim-cli-security-"));
  try {
    await writeFile(path.join(outside, "mcp.json"), '{"mcpServers":{}}\n');
    await symlink(
      outside,
      path.join(root, ".cursor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareHostPlans(["cursor"], "setup", root)).rejects.toThrow(
      /non-regular configuration directory/,
    );
    expect(await readFile(path.join(outside, "mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("trace refuses a symlinked trace directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-cli-security-"));
  const outside = await mkdtemp(path.join(tmpdir(), "thinktrim-cli-security-"));
  try {
    await mkdir(path.join(root, ".thinktrim"));
    await writeFile(path.join(outside, "trace.json"), '{"secret":"outside"}\n');
    await symlink(
      outside,
      path.join(root, ".thinktrim", "traces"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(runCli(["trace", "--workspace", root])).rejects.toThrow(
      /Trace directory must be a real directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
