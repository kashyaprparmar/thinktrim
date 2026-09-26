import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeDecisionBackend,
  createThinkTrimMcpServer,
  parseRemoteDataClasses,
} from "../src/index.js";
import type { ThinkTrimMcpOptions } from "../src/index.js";

const SECRET = "sk-or-test-secret-value";
const SOURCE_SENTINEL = "SOURCE_BODY_SENTINEL_7f3a";
const workspaces: string[] = [];

interface ToolBody {
  readonly ranked: readonly { readonly path: string }[];
  readonly calibrated: boolean;
  readonly confidence: number | null;
  readonly decisionBackend: {
    readonly remoteRequestsAttempted?: number;
    readonly candidatesScored?: number;
    readonly advisory?: { readonly scores: readonly { readonly score: number }[] };
    readonly remote?: { readonly requiredRemoteData: readonly string[] };
  };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-mcp-jev-"));
  workspaces.push(root);
  await mkdir(path.join(root, "src", "auth"), { recursive: true });
  await writeFile(
    path.join(root, "src", "auth", "token.ts"),
    `export function verifyToken(token: string): boolean {\n  // ${SOURCE_SENTINEL}\n  return token.length > 0;\n}\n`,
  );
  await writeFile(
    path.join(root, "src", "auth", "session.ts"),
    'import { verifyToken } from "./token";\nexport function openSession(token: string) { return verifyToken(token); }\n',
  );
  await writeFile(path.join(root, "src", "billing.ts"), "export function charge() { return 1; }\n");
  return root;
}

function scoreResponse(body: string): Response {
  const wire = JSON.parse(body) as { questions: Record<string, unknown> };
  const answers = Object.fromEntries(
    Object.keys(wire.questions).map((name, index) => [
      name,
      {
        type: "score",
        score: index === 0 ? 0 : 2,
        confidence: 0.7,
        legend: { "0": "not relevant", "1": "partly relevant", "2": "highly relevant" },
        probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 },
      },
    ]),
  );
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers,
      usage: { input_tokens: 300, output_tokens: 12 },
    }),
    { status: 200 },
  );
}

async function connect(options: ThinkTrimMcpOptions) {
  const server = createThinkTrimMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "thinktrim-jev-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      const block = result.content.find((item) => item.type === "text");
      if (!block || block.type !== "text") throw new Error("Expected a text MCP result");
      return { text: block.text, body: JSON.parse(block.text) as ToolBody };
    },
    close: () => client.close(),
  };
}

describe("MCP opt-in Jev decision backend", () => {
  it("parses only known remote data classes", () => {
    expect(parseRemoteDataClasses("task, paths,summaries,task")).toEqual([
      "task",
      "paths",
      "summaries",
    ]);
    expect(() => parseRemoteDataClasses("task,source")).toThrow(TypeError);
    expect(() => parseRemoteDataClasses(" , ")).toThrow(TypeError);
  });

  it("stays deterministic and makes no network call by default", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const session = await connect({
      workspaceRoot: await workspace(),
      decisionBackendRuntime: { env: { OPENROUTER_API_KEY: SECRET }, fetch: fetcher },
    });
    try {
      const { body } = await session.call("thinktrim_rank", { task: "verify token" });
      expect(body.decisionBackend).toMatchObject({
        backend: "deterministic",
        state: "deterministic",
      });
      expect(body.decisionBackend.advisory).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("does not send data without full ranking egress consent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const session = await connect({
      workspaceRoot: await workspace(),
      decisionBackend: { backend: "jev", allowedRemoteData: ["task", "paths"] },
      decisionBackendRuntime: { env: { OPENROUTER_API_KEY: SECRET }, fetch: fetcher },
    });
    try {
      const { body } = await session.call("thinktrim_rank", { task: "verify token" });
      expect(body.decisionBackend).toMatchObject({ backend: "jev", state: "egress_not_permitted" });
      expect(body.decisionBackend.remoteRequestsAttempted).toBeUndefined();
      const status = await session.call("thinktrim_status", {});
      expect(status.body.decisionBackend.remote?.requiredRemoteData).toEqual([
        "task",
        "paths",
        "summaries",
      ]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("reports a missing key without calling the backend", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const status = composeDecisionBackend(
      { backend: "jev", allowedRemoteData: ["task", "paths", "summaries"] },
      { env: {}, fetch: fetcher },
    );
    expect(status.status.state).toBe("missing_api_key");
    expect(status.status.remote?.apiKeyPresent).toBe(false);
    expect(status.remoteRanker).toBeUndefined();
  });

  it("returns uncalibrated Jev scores as an advisory beside deterministic ordering", async () => {
    const root = await workspace();
    const baseline = await connect({ workspaceRoot: root });
    const expected = (await baseline.call("thinktrim_rank", { task: "verify token session" })).body;
    await baseline.close();

    const bodies: string[] = [];
    const headers: Headers[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://openrouter.ai/api/alpha/decisions");
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers));
      return scoreResponse(String(init?.body));
    });
    const session = await connect({
      workspaceRoot: root,
      decisionBackend: { backend: "jev", allowedRemoteData: ["task", "paths", "summaries"] },
      decisionBackendRuntime: { env: { OPENROUTER_API_KEY: SECRET }, fetch: fetcher },
    });
    try {
      const tools = await session.call("thinktrim_status", {});
      expect(tools.body.decisionBackend).toMatchObject({
        state: "ready",
        appliesTo: ["thinktrim_rank"],
        remote: { endpointHost: "openrouter.ai", apiKeyPresent: true },
      });
      expect(tools.text).not.toContain(SECRET);

      const { text, body } = await session.call("thinktrim_rank", { task: "verify token session" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(headers[0]?.get("authorization")).toBe(`Bearer ${SECRET}`);
      expect(bodies[0]).toContain("src/auth/token.ts");
      expect(bodies[0]).not.toContain(SOURCE_SENTINEL);
      expect(body.ranked.map((item) => item.path)).toEqual(
        expected.ranked.map((item) => item.path),
      );
      expect(body.calibrated).toBe(false);
      expect(body.confidence).toBeNull();
      expect(body.decisionBackend).toMatchObject({
        backend: "jev",
        state: "ready",
        source: "advisory",
        reasonCode: "uncalibrated_backend_advisory",
        remoteRequestsAttempted: 1,
        usage: { unit: "tokens", inputUnits: 300, outputUnits: 12 },
        advisory: { calibrated: false, backend: { id: "jev-openrouter", locality: "remote" } },
      });
      const scores = body.decisionBackend.advisory?.scores ?? [];
      expect(scores.length).toBeGreaterThan(0);
      expect(scores.length).toBe(body.decisionBackend.candidatesScored);
      expect(scores.map((item) => item.score)).toEqual(
        [...scores.map((item) => item.score)].sort((a, b) => b - a),
      );
      expect(text).not.toContain(SECRET);
    } finally {
      await session.close();
    }
  });

  it("falls back to deterministic ranking when Jev fails", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("provider error", { status: 400 }),
    );
    const session = await connect({
      workspaceRoot: await workspace(),
      decisionBackend: { backend: "jev", allowedRemoteData: ["task", "paths", "summaries"] },
      decisionBackendRuntime: { env: { OPENROUTER_API_KEY: SECRET }, fetch: fetcher },
    });
    try {
      const { text, body } = await session.call("thinktrim_rank", { task: "verify token" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(body.ranked.length).toBeGreaterThan(0);
      expect(body.calibrated).toBe(false);
      expect(body.decisionBackend).toMatchObject({
        source: "deterministic",
        reasonCode: "backend_failure",
      });
      expect(body.decisionBackend.advisory).toBeUndefined();
      expect(text).not.toContain("provider error");
    } finally {
      await session.close();
    }
  });
});
