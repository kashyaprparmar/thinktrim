import { describe, expect, it, vi } from "vitest";
import type { DecisionKind, DecisionRequest } from "@thinktrim/core";
import { requests } from "../../core/tests/fixtures.js";
import { JevBackend } from "../src/index.js";

const remote = <K extends DecisionKind>(request: DecisionRequest<K>): DecisionRequest<K> =>
  ({
    ...request,
    constraints: {
      ...request.constraints,
      locality: "remote_allowed",
      allowedRemoteData: ["task", "paths"],
      deadlineMs: 5_000,
    },
  }) as DecisionRequest<K>;

function responseFor(body: string): Response {
  const wire = JSON.parse(body) as {
    questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
  };
  const answers = Object.fromEntries(
    Object.entries(wire.questions).map(([name, question]) => {
      if (question.type === "noul") return [name, { type: "noul", noul: 0.91 }];
      if (question.type === "choice") {
        const keys = Object.keys(question.criteria ?? {});
        return [
          name,
          {
            type: "choice",
            choice: keys[0],
            confidence: 0.8,
            probabilities: Object.fromEntries(
              keys.map((key, index) => [key, index === 0 ? 0.8 : 0.2]),
            ),
          },
        ];
      }
      return [
        name,
        {
          type: "score",
          score: 1.5,
          confidence: 0.7,
          legend: { "0": "not relevant", "1": "partly relevant", "2": "highly relevant" },
          probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
        },
      ];
    }),
  );
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers,
      usage: { input_tokens: 120, output_tokens: 8, cost: 0.000005 },
    }),
    { status: 200 },
  );
}

describe("JevBackend OpenRouter Decisions transport", () => {
  it("authenticates and maps binary, choice, and score decisions with usage", async () => {
    const seen: { url: string; headers: Headers; body: string; redirect?: RequestRedirect }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const body = String(init?.body);
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body,
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
      });
      return responseFor(body);
    };
    const backend = new JevBackend({ apiKey: "test-secret", fetch: fetcher });
    expect(await backend.health()).toBe("healthy");
    const [binary, choice, score] = await Promise.all([
      backend.predict(remote(requests.binary)),
      backend.predict(remote(requests.choice)),
      backend.predict(remote(requests.score)),
    ]);
    expect(binary.value).toEqual({ kind: "binary", value: true });
    expect(binary.rawSignal).toBe(0.91);
    expect(choice.value).toEqual({ kind: "choice", selectedId: requests.choice.candidates[0].id });
    expect(score.value).toEqual({
      kind: "score",
      scores: requests.score.candidates.map((candidate) => ({ id: candidate.id, score: 0.75 })),
    });
    expect(binary.usage).toEqual({ unit: "tokens", inputUnits: 120, outputUnits: 8 });
    expect(binary.metadata).toMatchObject({ costUSD: 0.000005, provider: "TypeSafe" });
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call.url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(call.headers.get("authorization")).toBe("Bearer test-secret");
      expect(call.redirect).toBe("error");
      expect(JSON.parse(call.body)).toMatchObject({ model: "typesafe/jev-1.13" });
    }
  });

  it("blocks invalid and local-only requests before any HTTP call", async () => {
    const fetcher = vi.fn(async () => responseFor("{}"));
    const backend = new JevBackend({ apiKey: "test-secret", fetch: fetcher });
    await expect(backend.predict(requests.binary)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(backend.predict({ ...remote(requests.choice), task: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(backend.predict(remote(requests.ranking))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      backend.predict({
        ...remote(requests.choice),
        dataClasses: ["task"],
        constraints: { ...remote(requests.choice).constraints, allowedRemoteData: ["task"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      backend.predict({
        ...remote(requests.binary),
        evidence: ["A source summary"],
        dataClasses: ["task"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries rate limits, temporary server failures, and connection resets", async () => {
    const statuses = [429, 503];
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      const status = statuses.shift();
      return status ? new Response("", { status }) : responseFor(String(init?.body));
    };
    const backend = new JevBackend({ apiKey: "test-secret", fetch: fetcher, retryBaseDelayMs: 0 });
    await backend.predict(remote(requests.binary));
    expect(calls).toBe(3);

    let resets = 0;
    const resetFetcher: typeof fetch = async (_input, init) => {
      resets += 1;
      if (resets === 1)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return responseFor(String(init?.body));
    };
    await new JevBackend({
      apiKey: "test-secret",
      fetch: resetFetcher,
      retryBaseDelayMs: 0,
    }).predict(remote(requests.binary));
    expect(resets).toBe(2);
  });

  it("does not retry semantic errors or invalid provider output", async () => {
    for (const status of [400, 401, 403, 422]) {
      const fetcher = vi.fn(async () => new Response("secret-bearing error body", { status }));
      const backend = new JevBackend({
        apiKey: "test-secret",
        fetch: fetcher,
        retryBaseDelayMs: 0,
      });
      await expect(backend.predict(remote(requests.binary))).rejects.toMatchObject({
        code: "backend_failure",
        status,
        attempts: 1,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const malformed = new JevBackend({
      apiKey: "test-secret",
      fetch: async () => new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: {} })),
    });
    await expect(malformed.predict(remote(requests.binary))).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("retries an attempt timeout but stops on caller cancellation", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return responseFor(String(init?.body));
    };
    const backend = new JevBackend({
      apiKey: "test-secret",
      fetch: fetcher,
      attemptTimeoutMs: 5,
      timeoutMs: 100,
      retryBaseDelayMs: 0,
    });
    expect((await backend.predict(remote(requests.binary))).value).toEqual({
      kind: "binary",
      value: true,
    });
    expect(calls).toBe(2);

    const controller = new AbortController();
    controller.abort();
    await expect(backend.predict(remote(requests.binary), controller.signal)).rejects.toMatchObject(
      {
        code: "cancelled",
      },
    );
    expect(calls).toBe(2);
  });

  it("does not send without a credential", async () => {
    const fetcher = vi.fn(async () => responseFor("{}"));
    const backend = new JevBackend({ apiKey: "", fetch: fetcher });
    expect(await backend.health()).toBe("unavailable");
    await expect(backend.predict(remote(requests.binary))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
