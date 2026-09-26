import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cli = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "thinktrim-mcp-profile-"));
const samples = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
    p95Ms: Number(
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(2),
    ),
  };
};
const responseBytes = (result) =>
  Buffer.byteLength(
    JSON.stringify(
      result.content.filter((entry) => entry.type === "text").map((entry) => entry.text),
    ),
  );
const measure = async (count, action) => {
  const values = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await action(i);
    values.push(performance.now() - start);
  }
  return samples(values);
};

try {
  for (let i = 0; i < 100; i++) {
    const directory = path.join(root, "src", `part-${Math.floor(i / 25)}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `file-${i}.ts`),
      `export function profileToken${i}() { return ${i}; }\n`,
    );
  }
  const beforeMemory = process.memoryUsage();
  const beforeCpu = process.cpuUsage();
  const client = new Client({ name: "thinktrim-profile", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  try {
    const connectStart = performance.now();
    await client.connect(transport);
    const connectMs = performance.now() - connectStart;
    const coldStart = performance.now();
    const coldResult = await client.callTool({
      name: "thinktrim_context",
      arguments: { task: "profile token", limit: 10 },
    });
    const coldContextMs = performance.now() - coldStart;
    const warmContext = await measure(30, () =>
      client.callTool({
        name: "thinktrim_context",
        arguments: { task: "profile token", limit: 10 },
      }),
    );
    const status = await measure(30, () =>
      client.callTool({ name: "thinktrim_status", arguments: {} }),
    );
    const ranking = await measure(20, () =>
      client.callTool({ name: "thinktrim_rank", arguments: { task: "profile token", limit: 10 } }),
    );
    const afterMemory = process.memoryUsage();
    const cpu = process.cpuUsage(beforeCpu);
    process.stdout.write(
      JSON.stringify({
        fixture: { sourceFiles: 100 },
        mcpProcessConnectAndInitializeMs: Number(connectMs.toFixed(2)),
        coldContextCallMs: Number(coldContextMs.toFixed(2)),
        coldContextResultBytes: responseBytes(coldResult),
        warmContextCall: warmContext,
        statusRoundTripOverhead: status,
        warmRankingCall: ranking,
        resultNote:
          "MCP client + stdio + server + tool handler; status is protocol baseline. No model inference.",
        clientProcess: {
          rssBeforeBytes: beforeMemory.rss,
          rssAfterBytes: afterMemory.rss,
          heapBeforeBytes: beforeMemory.heapUsed,
          heapAfterBytes: afterMemory.heapUsed,
          userCpuMs: Number((cpu.user / 1000).toFixed(2)),
          systemCpuMs: Number((cpu.system / 1000).toFixed(2)),
        },
      }) + "\n",
    );
  } finally {
    await client.close();
  }
} finally {
  if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) {
    await rm(root, { recursive: true, force: true });
  }
}
