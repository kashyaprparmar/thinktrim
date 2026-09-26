import { describe, expect, it } from "vitest";
import { requests } from "../../core/tests/fixtures.js";
import { LayaHTTPBackend } from "../src/index.js";

describe("LayaHTTPBackend", () => {
  it("uses the loopback server routes, optional auth, and provider model", async () => {
    const calls: { url: string; method: string; authorization: string | null; body?: string }[] =
      [];
    const backend = new LayaHTTPBackend({
      endpoint: "http://localhost:8000",
      apiKey: "laya-test-secret",
      model: "english",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }));
        return new Response(
          JSON.stringify({
            model: "english",
            answers: { decision: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 24, output_tokens: 1 },
          }),
        );
      },
    });

    expect(backend.capabilities.locality).toBe("local");
    expect(await backend.health()).toBe("healthy");
    const prediction = await backend.predict(requests.binary);
    expect(prediction.value).toEqual({ kind: "binary", value: true });
    expect(prediction.usage).toEqual({ unit: "tokens", inputUnits: 24, outputUnits: 1 });
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8000/health",
      "http://localhost:8000/v1/systemone",
    ]);
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[1]?.authorization).toBe("Bearer laya-test-secret");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toMatchObject({ model: "english" });
  });

  it("rejects non-loopback endpoints before assigning local capabilities", () => {
    expect(() => new LayaHTTPBackend({ endpoint: "https://laya.example.com" })).toThrow(/loopback/);
    expect(() => new LayaHTTPBackend({ endpoint: "http://user:secret@127.0.0.1:8000" })).toThrow(
      /loopback/,
    );
  });
});
