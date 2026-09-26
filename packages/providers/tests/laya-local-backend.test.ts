import type {
  SidecarClientOptions,
  SidecarOperation,
  SidecarRequestOptions,
} from "../../../services/laya-sidecar/node/client.mjs";
import { describe, expect, it } from "vitest";
import { requests } from "../../core/tests/fixtures.js";
import { LayaLocalBackend, type LayaSidecarClientLike } from "../src/index.js";

class MockSidecar implements LayaSidecarClientLike {
  starts = 0;
  stops = 0;
  activePredictions = 0;
  maxActivePredictions = 0;
  readonly operations: { op: string; params: unknown; options?: SidecarRequestOptions }[] = [];

  async start(): Promise<void> {
    this.starts += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  async request(
    op: SidecarOperation | string,
    params?: unknown,
    options?: SidecarRequestOptions,
  ): Promise<unknown> {
    this.operations.push({ op, params, ...(options === undefined ? {} : { options }) });
    if (op === "health") return { status: "ready" };
    if (op === "preload") return { loaded: true };
    if (op !== "predict") throw new Error(`unexpected operation ${op}`);
    this.activePredictions += 1;
    this.maxActivePredictions = Math.max(this.maxActivePredictions, this.activePredictions);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      const invocation = params as {
        questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
        lang?: string;
        model?: string;
      };
      const answers = Object.fromEntries(
        Object.entries(invocation.questions).map(([name, question]) => {
          if (question.type === "noul") return [name, { type: "noul", noul: 0.8 }];
          if (question.type === "choice") {
            const keys = Object.keys(question.criteria ?? {});
            return [
              name,
              {
                type: "choice",
                choice: keys[1] ?? keys[0],
                confidence: 0.84,
                probabilities: Object.fromEntries(
                  keys.map((key) => [key, key === keys[1] ? 0.84 : 0.16]),
                ),
              },
            ];
          }
          return [
            name,
            {
              type: "score",
              score: 1.5,
              confidence: 0.75,
              legend: { "0": "no", "1": "some", "2": "high" },
              probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
            },
          ];
        }),
      );
      return {
        model: invocation.model ?? "english",
        answers,
        usage: { input_tokens: 30, output_tokens: Object.keys(answers).length },
      };
    } finally {
      this.activePredictions -= 1;
    }
  }

  async shutdown(): Promise<void> {
    this.stops += 1;
  }
}

describe("LayaLocalBackend", () => {
  it("starts lazily once, preloads once, and serializes concurrent requests", async () => {
    const client = new MockSidecar();
    let childOptions: SidecarClientOptions | undefined;
    const backend = new LayaLocalBackend({
      model: "multilingual",
      device: "cpu",
      languageHint: "hi",
      preload: true,
      clientFactory: (options) => {
        childOptions = options;
        return client;
      },
    });
    expect(client.starts).toBe(0);
    expect(childOptions?.env?.THINKTRIM_LAYA_DEVICE).toBe("cpu");
    expect(backend.capabilities.kinds).toEqual(["binary", "choice", "score"]);
    expect(backend.capabilities.locality).toBe("local");

    const [binary, choice, score] = await Promise.all([
      backend.predict(requests.binary),
      backend.predict(requests.choice),
      backend.predict(requests.score),
    ]);
    expect(client.starts).toBe(1);
    expect(client.maxActivePredictions).toBe(1);
    expect(client.operations.filter((item) => item.op === "preload")).toHaveLength(1);
    expect(binary.value).toEqual({ kind: "binary", value: true });
    expect(choice.value).toEqual({ kind: "choice", selectedId: requests.choice.candidates[1]?.id });
    expect(score.value).toEqual({
      kind: "score",
      scores: requests.score.candidates.map((candidate) => ({ id: candidate.id, score: 0.75 })),
    });
    expect(
      client.operations
        .filter((item) => item.op === "predict")
        .every((item) => {
          const params = item.params as { model?: string; lang?: string };
          return params.model === "multilingual" && params.lang === "hi";
        }),
    ).toBe(true);
    await backend.shutdown();
    expect(client.stops).toBe(1);
  });

  it("supports per-request language hints and maps malformed provider output to a safe error", async () => {
    const client = new MockSidecar();
    const backend = new LayaLocalBackend({
      languageHint: (request) => (request.task.includes("Hindi") ? "hi" : undefined),
      client,
    });
    await backend.predict({ ...requests.choice, task: "Hindi parser task" });
    const params = client.operations.find((item) => item.op === "predict")?.params as {
      lang?: string;
    };
    expect(params.lang).toBe("hi");
    expect(await backend.health()).toBe("healthy");

    const malformedClient: LayaSidecarClientLike = {
      start: async () => {},
      request: async (op) =>
        op === "health" ? { status: "ready" } : { model: "x", answers: {}, usage: {} },
      shutdown: async () => {},
    };
    const malformed = new LayaLocalBackend({ client: malformedClient });
    await expect(malformed.predict(requests.binary)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("drains accepted work before idempotent shutdown and rejects later requests", async () => {
    const client = new MockSidecar();
    const backend = new LayaLocalBackend({ client });
    const prediction = backend.predict(requests.binary);
    const shutdown = backend.shutdown();

    await expect(backend.predict(requests.binary)).rejects.toMatchObject({
      code: "unavailable",
    });
    await prediction;
    await Promise.all([shutdown, backend.shutdown()]);

    expect(client.stops).toBe(1);
    await expect(backend.start()).rejects.toMatchObject({ code: "unavailable" });
  });
});
