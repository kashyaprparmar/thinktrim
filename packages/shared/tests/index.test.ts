import { CONTRACT_SCHEMA_VERSION, createCandidateId, isCandidateId } from "../src/index.js";

describe("shared contract metadata", () => {
  it("starts at schema version 1", () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(1);
  });
});

describe("candidate IDs", () => {
  it("preserves an opaque path or symbol ID exactly", () => {
    const id = "src/auth/login.ts#verify";
    expect(createCandidateId(id)).toBe(id);
    expect(isCandidateId(id)).toBe(true);
  });

  it.each(["", " src/file.ts", "src/file.ts ", "src/\u0000file.ts", "x".repeat(513)])(
    "rejects unstable or unsafe ID %j",
    (id) => {
      expect(isCandidateId(id)).toBe(false);
      expect(() => createCandidateId(id)).toThrow(TypeError);
    },
  );
});
