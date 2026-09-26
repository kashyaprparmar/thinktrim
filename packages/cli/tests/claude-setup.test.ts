import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyHostPlans, prepareHostPlans } from "../src/setup.js";

test("Claude project MCP setup merges, is idempotent, and uninstalls only its entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-claude-"));
  const target = path.join(root, ".mcp.json");
  const original = { mcpServers: { existing: { command: "other-server", args: [] } } };
  try {
    await writeFile(target, `${JSON.stringify(original)}\n`);
    const [plan] = await prepareHostPlans(["claude"], "setup", root);
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
      "${CLAUDE_PROJECT_DIR:-.}",
    ]);

    const [repeat] = await prepareHostPlans(["claude"], "setup", root);
    expect(repeat?.action).toBe("unchanged");
    const [removal] = await prepareHostPlans(["claude"], "uninstall", root);
    await applyHostPlans([removal!]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
