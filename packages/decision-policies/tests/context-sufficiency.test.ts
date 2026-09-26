import { describe, expect, it } from "vitest";
import { CoreDecisionEngine, FakeBackend } from "@thinktrim/core";
import type { ConfidencePolicy, DecisionOutcome, DecisionPolicy } from "@thinktrim/core";
import { ContextSufficiencyPolicy } from "../src/index.js";
import type { ContextSufficiencyInput } from "../src/index.js";

const evidence = [
  {
    id: "implementation",
    source: "src/auth/session.ts",
    summary: "refreshToken calls rotateSession after validating expiry",
    fingerprint: "sha256:implementation-v1",
  },
  {
    id: "tests",
    source: "src/auth/session.test.ts",
    summary: "tests cover expired refresh tokens and session rotation",
    fingerprint: "sha256:tests-v1",
  },
] as const;
const input: ContextSufficiencyInput = {
  task: "Fix expired refresh token rotation",
  retrievedEvidence: evidence,
  requiredEvidenceIds: ["implementation", "tests"],
};
const decisionPolicy: DecisionPolicy = {
  resolveExactly: () => undefined,
  validate: () => undefined,
  risk: () => "high",
};

function fixture(
  answer: boolean,
  outcome: DecisionOutcome = "accept",
  confidence: number | null = 0.98,
): { gate: ContextSufficiencyPolicy; backend: FakeBackend } {
  const backend = new FakeBackend();
  backend.enqueue({
    value: { kind: "binary", value: answer },
    rawSignal: 0.999,
    usage: { unit: "tokens", inputUnits: 10, outputUnits: 1 },
  });
  const confidencePolicy: ConfidencePolicy = {
    assess: () => ({
      outcome,
      confidence,
      calibrated: confidence !== null,
      reasonCode: "fixture_assessment",
    }),
  };
  return {
    gate: new ContextSufficiencyPolicy({
      engine: new CoreDecisionEngine({ backends: [backend], decisionPolicy, confidencePolicy }),
    }),
    backend,
  };
}

describe("ContextSufficiencyPolicy", () => {
  it("accepts sufficient only with covered evidence and calibrated confidence", async () => {
    const { gate, backend } = fixture(true);
    const result = await gate.assess(input);
    expect(result).toMatchObject({
      status: "sufficient",
      continueSearch: false,
      confidence: 0.98,
      calibrated: true,
      missingEvidenceIds: [],
      backend: { id: "fake" },
      usage: { unit: "tokens", inputUnits: 10, outputUnits: 1 },
    });
    expect(result.retrievedEvidence).toEqual(
      evidence.map(({ id, source, fingerprint }) => ({ id, source, fingerprint })),
    );
    expect(JSON.stringify(result)).not.toContain("refreshToken calls");
    expect(backend.calls[0]?.request).toMatchObject({
      category: "context_sufficiency",
      kind: "binary",
      dataClasses: ["task", "summaries"],
      constraints: { locality: "local_only", profile: "safe" },
    });
  });

  it("marks a confident negative as insufficient and permits search", async () => {
    const { gate } = fixture(false);
    expect(await gate.assess(input)).toMatchObject({
      status: "insufficient",
      continueSearch: true,
      reasonCode: "evidence_insufficient",
    });
  });

  it.each([0.2, 0.949, null])(
    "does not stop retrieval on low or uncalibrated confidence %s",
    async (confidence) => {
      const { gate } = fixture(true, confidence === null ? "unknown" : "accept", confidence);
      expect(await gate.assess(input)).toMatchObject({
        status: "uncertain",
        continueSearch: true,
        reasonCode: "confidence_inadequate",
      });
    },
  );

  it.each(["reject", "retrieve_more", "escalate", "unknown"] as const)(
    "treats a %s outcome as uncertain even with a true answer",
    async (outcome) => {
      const { gate } = fixture(true, outcome, 0.99);
      expect(await gate.assess(input)).toMatchObject({ status: "uncertain", continueSearch: true });
    },
  );

  it("reports missing required evidence without calling a backend", async () => {
    const { gate, backend } = fixture(true);
    const result = await gate.assess({
      ...input,
      retrievedEvidence: evidence.slice(0, 1),
    });
    expect(result).toMatchObject({
      status: "insufficient",
      continueSearch: true,
      reasonCode: "missing_required_evidence",
      missingEvidenceIds: ["tests"],
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("does not infer coverage from a plausible summary when no requirements are stated", async () => {
    const { gate, backend } = fixture(true);
    expect(await gate.assess({ ...input, requiredEvidenceIds: [] })).toMatchObject({
      status: "uncertain",
      continueSearch: true,
      reasonCode: "coverage_not_established",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("keeps searching when a known question remains unanswered", async () => {
    const { gate, backend } = fixture(true);
    expect(
      await gate.assess({ ...input, openQuestions: ["Where is the API entry point?"] }),
    ).toMatchObject({
      status: "insufficient",
      continueSearch: true,
      reasonCode: "open_questions",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("treats backend failure and cancellation as uncertainty", async () => {
    const backend = new FakeBackend({ health: "unavailable" });
    const confidencePolicy: ConfidencePolicy = {
      assess: () => ({ outcome: "accept", confidence: 1, calibrated: true, reasonCode: "fixture" }),
    };
    const gate = new ContextSufficiencyPolicy({
      engine: new CoreDecisionEngine({ backends: [backend], decisionPolicy, confidencePolicy }),
    });
    expect(await gate.assess(input)).toMatchObject({
      status: "uncertain",
      continueSearch: true,
      reasonCode: "unavailable",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await gate.assess(input, controller.signal)).toMatchObject({
      status: "uncertain",
      continueSearch: true,
      reasonCode: "cancelled",
    });
  });

  it("rejects duplicate evidence and unsafe remote permission declarations", async () => {
    const { gate } = fixture(true);
    await expect(
      gate.assess({ ...input, retrievedEvidence: [evidence[0], evidence[0]] }),
    ).rejects.toThrow("duplicate");
    await expect(
      gate.assess({ ...input, allowedRemoteData: ["task", "summaries"] }),
    ).rejects.toThrow("allowedRemoteData");
  });
});
