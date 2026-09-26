export const CONTRACT_SCHEMA_VERSION = 1 as const;

declare const candidateIdBrand: unique symbol;

/** Opaque and stable within the caller's workspace and candidate set. */
export type CandidateId = string & { readonly [candidateIdBrand]: "CandidateId" };

export function isCandidateId(value: unknown): value is CandidateId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }

  return true;
}

/** Preserves the caller's ID exactly; it never derives an ID from display text. */
export function createCandidateId(value: string): CandidateId {
  if (!isCandidateId(value)) {
    throw new TypeError(
      "Candidate ID must be a nonempty, trimmed string without control characters",
    );
  }
  return value;
}
