/** Deterministic candidate feature construction before any backend ranking. */
import { createHash } from "node:crypto";
import type { DecisionCandidate } from "@thinktrim/core";
import { createCandidateId } from "@thinktrim/shared";
import type {
  FileRecord,
  ImportRecord,
  RepositoryIndex,
  SymbolRecord,
} from "@thinktrim/repo-indexer";

export interface CandidateGenerationOptions {
  /** Target output size. Defaults to 30 and is capped at 40. */
  readonly maxCandidates?: number;
  /** Number of lexical and symbol hits to inspect before structural expansion. Defaults to 200. */
  readonly retrievalLimit?: number;
  /** Maximum dependencies and dependents inspected per seed file. Defaults to 2. */
  readonly structuralNeighborsPerSeed?: number;
}

export interface CandidateMetadata {
  readonly id: string;
  readonly path: string;
  readonly language: string | null;
  readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly ImportRecord[];
  readonly contentFingerprint: string;
  /** Deterministic pre-ranking relevance score; this is not backend confidence. */
  readonly score: number;
  readonly sources: readonly ("lexical" | "symbol" | "dependency" | "dependent")[];
  readonly matchedTerms: readonly string[];
  readonly description: string;
}

export interface CandidateGenerationResult {
  /** Ready to place directly in a core DecisionRequest. */
  readonly candidates: readonly DecisionCandidate[];
  /** Extra local diagnostics, keyed by candidate ID; these are not sent to a backend. */
  readonly details: readonly CandidateMetadata[];
  readonly examined: number;
  readonly truncated: boolean;
}

interface CandidateAccumulator {
  readonly file: FileRecord;
  score: number;
  readonly sources: Set<CandidateMetadata["sources"][number]>;
  readonly matchedTerms: Set<string>;
}

const queryTokenPattern = /[\p{L}\p{N}]+/gu;

function termsOf(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(queryTokenPattern) ?? []
  ).filter((term) => term.length > 1 || /\d/.test(term));
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function shortList(items: readonly string[], count: number, maxItemLength = 72): string {
  const visible = items.slice(0, count).map((item) => item.slice(0, maxItemLength));
  if (items.length > count) visible.push(`+${items.length - count} more`);
  return visible.join(", ") || "none";
}

function describe(
  file: FileRecord,
  symbols: readonly string[],
  imports: readonly string[],
  matched: readonly string[],
): string {
  const full = [
    file.path,
    `Symbols: ${shortList(symbols, 5)}`,
    `Imports: ${shortList(imports, 6)}`,
    `Matched terms: ${shortList(matched, 8, 40)}`,
  ]
    .join(" | ")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  return full.length <= 512 ? full : `${full.slice(0, 509)}...`;
}

function optionsFor(options: CandidateGenerationOptions): Required<CandidateGenerationOptions> {
  const maxCandidates = positiveInteger(options.maxCandidates, 30, "maxCandidates");
  const retrievalLimit = positiveInteger(options.retrievalLimit, 200, "retrievalLimit");
  const structuralNeighborsPerSeed = positiveInteger(
    options.structuralNeighborsPerSeed,
    2,
    "structuralNeighborsPerSeed",
  );
  if (maxCandidates > 40) throw new RangeError("maxCandidates cannot exceed 40");
  if (retrievalLimit > 1000) throw new RangeError("retrievalLimit cannot exceed 1,000");
  if (structuralNeighborsPerSeed > 8) {
    throw new RangeError("structuralNeighborsPerSeed cannot exceed 8");
  }
  return { maxCandidates, retrievalLimit, structuralNeighborsPerSeed };
}

function addCandidate(
  pool: Map<string, CandidateAccumulator>,
  file: FileRecord | undefined,
  score: number,
  source: CandidateMetadata["sources"][number],
  matched: readonly string[] = [],
): void {
  if (!file) return;
  let candidate = pool.get(file.path);
  if (!candidate) {
    candidate = { file, score: 0, sources: new Set(), matchedTerms: new Set() };
    pool.set(file.path, candidate);
  }
  candidate.score += score;
  candidate.sources.add(source);
  for (const term of matched) candidate.matchedTerms.add(term);
}

/**
 * Builds a small deterministic shortlist from an index. Descriptions contain
 * metadata only; file contents are never copied into candidate labels/features.
 */
export function generateCandidates(
  index: RepositoryIndex,
  query: string,
  options: CandidateGenerationOptions = {},
): CandidateGenerationResult {
  const config = optionsFor(options);
  const queryTerms = [...new Set(termsOf(query))];
  if (queryTerms.length === 0)
    return { candidates: [], details: [], examined: 0, truncated: false };

  const lexicalHits = index.searchFiles(query, { limit: config.retrievalLimit });
  const symbolHits = index.searchSymbols(query, { limit: config.retrievalLimit });
  const pool = new Map<string, CandidateAccumulator>();
  const maxLexical = Math.max(0, ...lexicalHits.map((hit) => hit.score));
  const maxSymbol = Math.max(0, ...symbolHits.map((hit) => hit.score));

  for (const hit of lexicalHits) {
    addCandidate(
      pool,
      hit.item,
      maxLexical > 0 ? 0.7 * (hit.score / maxLexical) : 0,
      "lexical",
      hit.matchedTerms ?? [],
    );
  }
  for (const hit of symbolHits) {
    const file = index.getFile(hit.item.filePath);
    addCandidate(
      pool,
      file,
      maxSymbol > 0 ? 0.2 * (hit.score / maxSymbol) : 0,
      "symbol",
      queryTerms.filter((term) => termsOf(hit.item.name).includes(term)),
    );
  }

  const seeds = [...pool.values()]
    .sort(
      (left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path),
    )
    .slice(0, Math.min(config.maxCandidates, 20));
  const queried = new Set<string>();
  for (const seed of seeds) {
    if (queried.has(seed.file.path)) continue;
    queried.add(seed.file.path);
    const dependencies = index
      .getDependencies(seed.file.path)
      .slice(0, config.structuralNeighborsPerSeed);
    const dependents = index
      .getDependents(seed.file.path)
      .slice(0, config.structuralNeighborsPerSeed);
    for (let i = 0; i < dependencies.length; i++) {
      addCandidate(pool, index.getFile(dependencies[i]!), 0.12 / (i + 1), "dependency");
    }
    for (let i = 0; i < dependents.length; i++) {
      addCandidate(pool, index.getFile(dependents[i]!), 0.12 / (i + 1), "dependent");
    }
  }

  const ranked = [...pool.values()].sort(
    (left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path),
  );
  const candidates: DecisionCandidate[] = [];
  const details: CandidateMetadata[] = [];
  for (const entry of ranked.slice(0, config.maxCandidates)) {
    const symbols = [...new Set(entry.file.symbols.map((symbol) => symbol.name))];
    const imports = [...new Set(entry.file.imports.map((item) => item.specifier))];
    const matchedTerms = [...entry.matchedTerms].sort();
    const description = describe(entry.file, symbols, imports, matchedTerms);
    const id = createCandidateId(
      `file:${createHash("sha256").update(entry.file.path).digest("hex").slice(0, 32)}`,
    );
    const features = {
      path: entry.file.path.slice(0, 4096),
      language: entry.file.language ?? "unknown",
      score: Number(entry.score.toFixed(6)),
      matchedTerms: shortList(matchedTerms, 32, 64).slice(0, 2048),
      symbols: shortList(symbols, 12, 64).slice(0, 2048),
      imports: shortList(imports, 12, 64).slice(0, 2048),
      sources: [...entry.sources].sort().join(","),
    };
    candidates.push({
      id,
      label: description,
      features,
      contentFingerprint: entry.file.sha256,
    });
    details.push({
      id,
      path: entry.file.path,
      language: entry.file.language,
      symbols: entry.file.symbols,
      imports: entry.file.imports,
      contentFingerprint: entry.file.sha256,
      score: entry.score,
      sources: [...entry.sources].sort(),
      matchedTerms,
      description,
    });
  }
  return {
    candidates,
    details,
    examined: lexicalHits.length + symbolHits.length,
    truncated: ranked.length > candidates.length || lexicalHits.length === config.retrievalLimit,
  };
}

export { ContextRankingPolicy } from "./policy.js";
export type {
  ContextRankingAdvisory,
  ContextRankingInput,
  ContextRankingPolicyOptions,
  ContextRankingResult,
  RankedContextCandidate,
} from "./policy.js";
