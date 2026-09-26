import type { DecisionBackend } from "@thinktrim/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  JevBackend,
  LayaHTTPBackend,
  LayaLocalBackend,
  SystemOneHTTPTransport,
} from "../src/index.js";
import {
  layaLocalInvocation,
  localCapabilities,
  remoteCapabilities,
  systemOneRequest,
  systemOneResponse,
} from "./fixtures.js";

describe("provider contract fixtures", () => {
  it("keeps every prepared backend assignable to the core contract", () => {
    expectTypeOf<LayaLocalBackend>().toExtend<DecisionBackend>();
    expectTypeOf<LayaHTTPBackend>().toExtend<DecisionBackend>();
    expectTypeOf<JevBackend>().toExtend<DecisionBackend>();
    expect(localCapabilities.locality).toBe("local");
    expect(remoteCapabilities.locality).toBe("remote");
  });

  it("uses the same typed questions for Laya local and the shared HTTP wire", () => {
    expect(layaLocalInvocation.questions).toBe(systemOneRequest.questions);
    expect("model" in layaLocalInvocation).toBe(false);
    expect(Object.keys(systemOneResponse.answers)).toEqual(Object.keys(systemOneRequest.questions));
    expect(Object.values(systemOneResponse.answers).map((answer) => answer.type)).toEqual([
      "noul",
      "choice",
      "score",
    ]);
  });

  it("allows an injected HTTP transport to return untrusted wire data", async () => {
    const transport: SystemOneHTTPTransport = {
      postSystemOne: async (_request, options) => {
        if (options?.signal?.aborted) throw new Error("aborted");
        return systemOneResponse;
      },
    };
    expect(await transport.postSystemOne(systemOneRequest)).toBe(systemOneResponse);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.postSystemOne(systemOneRequest, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
