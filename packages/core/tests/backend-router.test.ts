import { describe, expect, it } from "vitest";
import { BackendRouter, CoreDecisionEngine, FakeBackend } from "../src/index.js";
import type { ConfidencePolicy, DecisionPolicy, DecisionRequest } from "../src/index.js";
import { requests } from "./fixtures.js";

const policy: DecisionPolicy = {
  resolveExactly: () => undefined,
  validate: () => undefined,
  risk: () => "low",
};
const confidence: ConfidencePolicy = {
  assess: () => ({ outcome: "accept", confidence: 0.99, calibrated: true, reasonCode: "fixture" }),
};

function request(
  routing: NonNullable<DecisionRequest<"binary">["constraints"]["routing"]> = {},
): DecisionRequest<"binary"> {
  return {
    ...requests.binary,
    constraints: {
      ...requests.binary.constraints,
      locality: "remote_allowed",
      allowedRemoteData: ["task"],
      routing,
    },
  };
}

function backends(): { local: FakeBackend; remote: FakeBackend } {
  return {
    local: new FakeBackend({ capabilities: { id: "laya", locality: "local" } }),
    remote: new FakeBackend({ capabilities: { id: "jev", locality: "remote" } }),
  };
}

describe("BackendRouter", () => {
  it("preserves configured order by default and exposes local preference", () => {
    const { local, remote } = backends();
    const router = new BackendRouter();
    expect(router.plan(request(), [remote, local]).attempts.map((item) => item.backendId)).toEqual([
      "jev",
      "laya",
    ]);
    expect(
      router
        .plan(request({ localPreference: true }), [remote, local])
        .attempts.map((item) => item.backendId),
    ).toEqual(["laya", "jev"]);
  });

  it("keeps overrides strict unless fallback is explicitly permitted", () => {
    const { local, remote } = backends();
    const router = new BackendRouter();
    const strict = router.plan(request({ backendId: "jev" }), [local, remote]);
    expect(strict.attempts.map((item) => item.backendId)).toEqual(["jev"]);
    expect(strict.skipped).toContainEqual(
      expect.objectContaining({ backendId: "laya", reasonCode: "fallback_disabled" }),
    );
    const fallback = router.plan(request({ backendId: "jev", fallback: "permitted" }), [
      local,
      remote,
    ]);
    expect(fallback.attempts.map((item) => item.backendId)).toEqual(["jev", "laya"]);
    expect(
      router.plan(request({ backendId: "typo", fallback: "permitted" }), [local, remote]).attempts,
    ).toEqual([]);
  });

  it("never lets mode, network, or hints bypass privacy and capability limits", () => {
    const { local, remote } = backends();
    const router = new BackendRouter({
      hints: { jev: { languages: ["typescript"], qualityRank: 9 } },
    });
    const privateRequest = {
      ...requests.binary,
      constraints: {
        ...requests.binary.constraints,
        routing: { mode: "remote" as const, optimizeFor: "quality" as const },
      },
    };
    const privacy = router.plan(privateRequest, [local, remote]);
    expect(privacy.attempts).toEqual([]);
    expect(privacy.skipped).toContainEqual(
      expect.objectContaining({ backendId: "jev", reasonCode: "privacy_denied" }),
    );
    expect(
      router
        .plan(request({ networkAvailable: false }), [local, remote])
        .attempts.map((item) => item.backendId),
    ).toEqual(["laya"]);
    expect(
      router
        .plan(request({ language: "python" }), [local, remote])
        .attempts.map((item) => item.backendId),
    ).toEqual(["laya"]);
    const unavailable = new BackendRouter({ availability: { jev: "unavailable" } });
    expect(unavailable.plan(request(), [local, remote]).skipped).toContainEqual(
      expect.objectContaining({ backendId: "jev", reasonCode: "known_unavailable" }),
    );
    const ranked = new BackendRouter({
      hints: {
        laya: { latencyRank: 1, qualityRank: 1 },
        jev: { latencyRank: 9, qualityRank: 9 },
      },
    });
    expect(
      ranked.plan(request({ optimizeFor: "latency" }), [remote, local]).attempts[0]?.backendId,
    ).toBe("laya");
    expect(
      ranked.plan(request({ optimizeFor: "quality" }), [local, remote]).attempts[0]?.backendId,
    ).toBe("jev");
    const small = new FakeBackend({ capabilities: { id: "small", maxCandidates: 1 } });
    expect(router.plan(request(), [small]).attempts).toHaveLength(1);
    expect(
      router.plan(
        { ...requests.choice, constraints: { ...requests.choice.constraints, maxCandidates: 10 } },
        [small],
      ).attempts,
    ).toHaveLength(0);
  });

  it("fails over from local to remote only when privacy permits it", async () => {
    const { local, remote } = backends();
    local.healthStatus = "unavailable";
    remote.enqueue({ value: { kind: "binary", value: true } });
    const engine = new CoreDecisionEngine({
      backends: [local, remote],
      decisionPolicy: policy,
      confidencePolicy: confidence,
    });
    const input = request({ localPreference: true });
    expect(engine.planRoute(input).attempts.map((item) => item.backendId)).toEqual(["laya", "jev"]);
    const result = await engine.decide(input);
    expect(result.backend?.id).toBe("jev");
    expect(result.outcome).toBe("accept");
    expect(result.trace.stages).toContainEqual(
      expect.objectContaining({ name: "health", outcome: "unavailable", backendId: "laya" }),
    );
    const blocked = await engine.decide({
      ...input,
      constraints: { ...input.constraints, locality: "local_only", allowedRemoteData: [] },
    });
    expect(blocked.outcome).toBe("unknown");
    expect(remote.calls).toHaveLength(1);
  });
});
