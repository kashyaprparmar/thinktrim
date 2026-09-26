import * as TOML from "@iarna/toml";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { applyHostPlans, prepareHostPlans } from "../src/setup.js";

test("Codex project MCP setup preserves other settings and scopes the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-codex-"));
  const target = path.join(root, ".codex", "config.toml");
  try {
    await mkdir(path.dirname(target));
    await writeFile(target, 'model = "gpt-6-sol"\n[mcp_servers.other]\ncommand = "other-server"\n');
    const [plan] = await prepareHostPlans(["codex"], "setup", root);
    expect(plan?.target).toBe(target);
    expect(plan?.action).toBe("update");
    await applyHostPlans([plan!]);
    const configured = TOML.parse(await readFile(target, "utf8")) as {
      model: string;
      mcp_servers: Record<string, { command: string; args: string[]; cwd: string }>;
    };
    expect(configured.model).toBe("gpt-6-sol");
    expect(configured.mcp_servers.other?.command).toBe("other-server");
    expect(configured.mcp_servers.thinktrim?.command).toBe(process.execPath);
    expect(configured.mcp_servers.thinktrim?.cwd).toBe(root);
    expect(configured.mcp_servers.thinktrim?.args.slice(-3)).toEqual(["mcp", "--workspace", root]);

    const [repeat] = await prepareHostPlans(["codex"], "setup", root);
    expect(repeat?.action).toBe("unchanged");
    const [removal] = await prepareHostPlans(["codex"], "uninstall", root);
    await applyHostPlans([removal!]);
    const remaining = TOML.parse(await readFile(target, "utf8")) as {
      model: string;
      mcp_servers: Record<string, unknown>;
    };
    expect(remaining.model).toBe("gpt-6-sol");
    expect(remaining.mcp_servers.other).toBeDefined();
    expect(remaining.mcp_servers.thinktrim).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
