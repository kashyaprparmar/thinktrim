import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, test } from "vitest";

const cliEntry = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function body(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Expected a text MCP result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

test("stdio handshake, tool calls, and argument rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-mcp-"));
  workspaces.push(root);
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  await writeFile(
    path.join(root, "src", "auth", "token.ts"),
    "export function verifyToken(token: string): boolean { return token.length > 0; }\n",
  );
  const client = new Client({ name: "thinktrim-protocol-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of [
      "thinktrim_context",
      "thinktrim_rank",
      "thinktrim_gate",
      "thinktrim_classify",
    ]) {
      expect(tools.tools.some((tool) => tool.name === name)).toBe(true);
    }

    const context = body(
      await client.callTool({
        name: "thinktrim_context",
        arguments: { task: "verify token", limit: 5 },
      }),
    );
    expect(
      (context.candidates as { path: string }[]).some((item) => item.path === "src/auth/token.ts"),
    ).toBe(true);

    const rank = body(
      await client.callTool({
        name: "thinktrim_rank",
        arguments: { task: "verify token", limit: 5 },
      }),
    );
    expect(rank.calibrated).toBe(false);
    expect((rank.ranked as unknown[]).length).toBeGreaterThan(0);

    const gate = body(
      await client.callTool({
        name: "thinktrim_gate",
        arguments: { task: "verify token", retrievedEvidence: [], requiredEvidenceIds: ["auth"] },
      }),
    );
    expect(gate.status).toBe("insufficient");
    expect(gate.continueSearch).toBe(true);

    const uncertain = body(
      await client.callTool({
        name: "thinktrim_gate",
        arguments: {
          task: "verify token",
          retrievedEvidence: [
            {
              id: "auth",
              source: "src/auth/token.ts",
              summary: "verifies token",
              fingerprint: "v1",
            },
          ],
          requiredEvidenceIds: ["auth"],
        },
      }),
    );
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.continueSearch).toBe(true);

    const classification = body(
      await client.callTool({
        name: "thinktrim_classify",
        arguments: { output: "SyntaxError: Unexpected token", exitCode: 1 },
      }),
    );
    expect(classification.category).toBe("syntax_error");

    const invalid = await client.callTool({
      name: "thinktrim_context",
      arguments: { task: "", limit: 5 },
    });
    expect(invalid.isError).toBe(true);
    const unsafe = await client.callTool({
      name: "thinktrim_get_dependencies",
      arguments: { path: "../outside.ts" },
    });
    expect(unsafe.isError).toBe(true);
  } finally {
    await client.close();
  }
});
