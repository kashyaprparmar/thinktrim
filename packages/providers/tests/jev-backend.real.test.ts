import { describe, expect, it } from "vitest";
import { requests } from "../../core/tests/fixtures.js";
import { JevBackend } from "../src/index.js";

describe.skipIf(!process.env.OPENROUTER_API_KEY)("JevBackend live OpenRouter", () => {
  it("gets a typed decision from typesafe/jev-1.13", async () => {
    const backend = new JevBackend({ maxAttempts: 2, timeoutMs: 30_000 });
    const prediction = await backend.predict({
      ...requests.binary,
      task: "Is TypeScript a programming language?",
      constraints: {
        ...requests.binary.constraints,
        locality: "remote_allowed",
        allowedRemoteData: ["task"],
        deadlineMs: 30_000,
      },
    });
    expect(prediction.value.kind).toBe("binary");
    expect(prediction.rawSignal).toBeGreaterThanOrEqual(0);
    expect(prediction.rawSignal).toBeLessThanOrEqual(1);
    expect(prediction.metadata?.resolvedModel).toMatch(/^typesafe\/jev-1\.13/);
    expect(prediction.usage?.inputUnits).toBeGreaterThan(0);
  }, 35_000);
});
