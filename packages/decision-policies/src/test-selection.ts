import { createHash } from "node:crypto";
import path from "node:path";
import { createCandidateId } from "@thinktrim/shared";
import type { CandidateMetadata, ContextRankingPolicy } from "@thinktrim/context-ranker";
import type { RepositoryIndex, FileRecord } from "@thinktrim/repo-indexer";

export interface TestSelectionInput {
  readonly task: string;
  readonly changedFiles?: readonly string[];
  /** Output from `git diff --name-only -z`; newline-separated output is also accepted. */
  readonly gitDiff?: string;
  readonly maxCandidates?: number;
}

export interface TestSelectionPolicyOptions {
  /** Optional ranking backend. It may reorder the deterministic shortlist only. */
  readonly reranker?: ContextRankingPolicy;
}

export interface TestCandidate {
  readonly path: string;
  readonly packageRoot: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly changed: boolean;
}

export interface TestSelectionResult {
  readonly candidates: readonly TestCandidate[];
  readonly changedFiles: readonly string[];
  readonly truncated: boolean;
  /** ThinkTrim selection is supplemental; the host must still run full CI. */
  readonly alwaysRunFullCi: true;
  readonly reranking: {
    readonly used: boolean;
    readonly reasonCode: string;
    readonly backendId?: string;
  };
}

function normalizePath(value: string): string | undefined {
  if (
    !value ||
    value.length > 4096 ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized.replace(/^\.\//, "");
}

function parseDiffPaths(diff: string | undefined): string[] {
  if (!diff) return [];
  const raw = diff.includes("\0") ? diff.split("\0") : diff.split(/\r?\n/);
  return raw.map(normalizePath).filter((item): item is string => item !== undefined);
}

function isTestPath(filePath: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/i.test(filePath) ||
    /\.(?:test|spec)\.[^/.]+$/i.test(filePath) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(filePath) ||
    /_test\.go$/i.test(filePath) ||
    /(?:Tests?|Specs?)\.[^.]+$/i.test(path.posix.basename(filePath))
  );
}

function packageRoots(index: RepositoryIndex): string[] {
  return [...index.files.keys()]
    .filter((filePath) => filePath.endsWith("package.json"))
    .map((filePath) => path.posix.dirname(filePath))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function packageRoot(filePath: string, roots: readonly string[]): string {
  let best = ".";
  for (const root of roots) {
    if (root === "." || filePath === root || filePath.startsWith(`${root}/`)) {
      if (root.length > best.length) best = root;
    }
  }
  return best;
}

function withoutTestSuffix(filePath: string): string {
  const base = path.posix
    .basename(filePath)
    .replace(/\.(?:test|spec)(?=\.)/i, "")
    .replace(/_test(?=\.)/i, "")
    .replace(/(?:Tests|Test|Specs|Spec)$/i, "")
    .replace(/^test_/i, "");
  return base.replace(/\.[^.]+$/, "").toLowerCase();
}

function candidateMetadata(file: FileRecord, score: number): CandidateMetadata {
  const id = createCandidateId(`test:${file.path}`);
  return {
    id,
    path: file.path,
    language: file.language,
    symbols: file.symbols,
    imports: file.imports,
    contentFingerprint: file.sha256,
    score,
    sources: ["lexical"],
    matchedTerms: [],
    description: `${file.path}\nSymbols: ${file.symbols
      .slice(0, 5)
      .map((symbol) => symbol.name)
      .join(", ")}`.slice(0, 512),
  };
}

/** Generates tests deterministically, then optionally asks the ranker only to reorder them. */
export class TestSelectionPolicy {
  private readonly reranker: ContextRankingPolicy | undefined;

  constructor(options: TestSelectionPolicyOptions = {}) {
    this.reranker = options.reranker;
  }

  async select(index: RepositoryIndex, input: TestSelectionInput): Promise<TestSelectionResult> {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 10_000) {
      throw new TypeError("task is invalid");
    }
    const maxCandidates = input.maxCandidates ?? 30;
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 40) {
      throw new RangeError("maxCandidates must be between 1 and 40");
    }
    const changed = new Set<string>();
    for (const filePath of [...(input.changedFiles ?? []), ...parseDiffPaths(input.gitDiff)]) {
      const normalized = normalizePath(filePath);
      if (normalized) changed.add(normalized);
    }
    const changedFiles = [...changed].sort();
    if (changedFiles.length === 0) {
      return {
        candidates: [],
        changedFiles,
        truncated: false,
        alwaysRunFullCi: true,
        reranking: { used: false, reasonCode: "no_indexed_changes" },
      };
    }

    const roots = packageRoots(index);
    const pool = new Map<string, { score: number; reasons: Set<string>; changed: boolean }>();
    const add = (filePath: string, score: number, reason: string, isChanged = false): void => {
      const current = pool.get(filePath) ?? {
        score: 0,
        reasons: new Set<string>(),
        changed: false,
      };
      current.score = Math.max(current.score, score);
      current.reasons.add(reason);
      current.changed ||= isChanged;
      pool.set(filePath, current);
    };
    const allTests = [...index.files.keys()].filter(isTestPath).sort();

    for (const changedPath of changedFiles) {
      if (isTestPath(changedPath) && index.getFile(changedPath)) {
        add(changedPath, 1, "changed_test", true);
      }
      const root = packageRoot(changedPath, roots);
      const stem = withoutTestSuffix(changedPath);
      for (const testPath of allTests) {
        const testFile = index.getFile(testPath);
        if (!testFile) continue;
        if (testPath === changedPath) continue;
        const samePackage = packageRoot(testPath, roots) === root;
        const importsChanged = testFile.imports.some((item) => item.resolvedPath === changedPath);
        const stemMatch = withoutTestSuffix(testPath) === stem;
        if (importsChanged) add(testPath, 0.98, "imports_changed_file");
        if (stemMatch && samePackage) add(testPath, 0.92, "test_filename_convention");
        if (samePackage && !isTestPath(changedPath)) {
          const sibling = index.getDependents(changedPath).includes(testPath);
          if (sibling) add(testPath, 0.98, "dependency_edge");
          else if (!importsChanged && !stemMatch) add(testPath, 0.25, "same_package_fallback");
        }
      }
    }

    const ordered = [...pool.entries()].sort(
      (a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]),
    );
    const truncated = ordered.length > maxCandidates;
    const bounded = ordered.slice(0, maxCandidates);
    const byPath = new Map(bounded.map(([filePath, detail]) => [filePath, detail]));
    let chosenPaths = bounded.map(([filePath]) => filePath);
    let reranking: TestSelectionResult["reranking"] = {
      used: false,
      reasonCode: this.reranker ? "no_candidates_or_reranker" : "deterministic_only",
    };

    if (this.reranker && chosenPaths.length > 0) {
      try {
        const metadata = chosenPaths.flatMap((filePath) => {
          const file = index.getFile(filePath);
          const detail = byPath.get(filePath);
          return file && detail ? [candidateMetadata(file, detail.score)] : [];
        });
        const ranked = await this.reranker.rank({ task: input.task, candidates: metadata });
        const validIds = new Map(metadata.map((item) => [item.id, item.path]));
        const modelOrder = ranked.ranked
          .map((item) => validIds.get(item.id))
          .filter((item): item is string => item !== undefined);
        const backendRerank =
          ranked.metadata.strategy === "grouped_score" &&
          ranked.ranked.some((item) => item.source === "backend");
        if (
          backendRerank &&
          modelOrder.length === chosenPaths.length &&
          new Set(modelOrder).size === chosenPaths.length
        ) {
          chosenPaths = modelOrder;
          reranking = {
            used: true,
            reasonCode: ranked.metadata.reasonCode,
            ...(ranked.backend === undefined ? {} : { backendId: ranked.backend.id }),
          };
        } else {
          reranking = { used: false, reasonCode: "invalid_reranker_order" };
        }
      } catch {
        reranking = { used: false, reasonCode: "reranker_failure" };
      }
    }

    return {
      candidates: chosenPaths.flatMap((filePath) => {
        const detail = byPath.get(filePath);
        if (!detail) return [];
        return [
          {
            path: filePath,
            packageRoot: packageRoot(filePath, roots),
            score: detail.score,
            reasons: [...detail.reasons].sort(),
            changed: detail.changed,
          },
        ];
      }),
      changedFiles,
      truncated,
      alwaysRunFullCi: true,
      reranking,
    };
  }
}

/** Stable key helper for external caches; includes the changed paths and content fingerprints. */
export function testSelectionFingerprint(index: RepositoryIndex, paths: readonly string[]): string {
  const entries = [...new Set(paths)]
    .sort()
    .map((filePath) => `${filePath}:${index.getFile(filePath)?.sha256 ?? "missing"}`);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
