import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyHostPlans, prepareHostPlans } from "../src/setup.js";

test("Cursor project MCP setup preserves other servers and scopes the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-cursor-"));
  const target = path.join(root, ".cursor", "mcp.json");
  const original = { mcpServers: { existing: { command: "other-server", args: [] } } };
  try {
    await mkdir(path.dirname(target));
    await writeFile(target, `${JSON.stringify(original)}\n`);
    const [plan] = await prepareHostPlans(["cursor"], "setup", root);
    expect(plan?.target).toBe(target);
    expect(plan?.action).toBe("update");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(original);

    await applyHostPlans([plan!]);
    const configured = JSON.parse(await readFile(target, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(configured.mcpServers.existing).toEqual(original.mcpServers.existing);
    expect(configured.mcpServers.thinktrim?.command).toBe(process.execPath);
    expect(configured.mcpServers.thinktrim?.args.slice(-3)).toEqual([
      "mcp",
      "--workspace",
      "${workspaceFolder}",
    ]);

    const [repeat] = await prepareHostPlans(["cursor"], "setup", root);
    expect(repeat?.action).toBe("unchanged");
    const [removal] = await prepareHostPlans(["cursor"], "uninstall", root);
    await applyHostPlans([removal!]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
