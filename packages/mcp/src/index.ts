import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ContextRankingPolicy, generateCandidates } from "@thinktrim/context-ranker";
import type { CandidateMetadata, RankedContextCandidate } from "@thinktrim/context-ranker";
import type { DecisionEngine } from "@thinktrim/core";
import {
  ContextSufficiencyPolicy,
  FailureClassificationPolicy,
} from "@thinktrim/decision-policies";
import { indexWorkspace } from "@thinktrim/repo-indexer";
import type { RepositoryIndex } from "@thinktrim/repo-indexer";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { z } from "zod/v4";
import { composeDecisionBackend, describeDecisionBackend } from "./decision-backend.js";
import type {
  ComposeDecisionBackendOptions,
  McpDecisionBackendConfig,
} from "./decision-backend.js";

export {
  composeDecisionBackend,
  describeDecisionBackend,
  parseDecisionBackend,
  parseRemoteDataClasses,
  RANK_REMOTE_DATA,
} from "./decision-backend.js";
export type {
  McpDecisionBackend,
  McpDecisionBackendConfig,
  McpDecisionBackendState,
  McpDecisionBackendStatus,
} from "./decision-backend.js";

export interface ThinkTrimMcpOptions {
  readonly workspaceRoot?: string;
  readonly serverVersion?: string;
  /** Optional calibrated engine; otherwise the sufficiency gate stays conservative. */
  readonly decisionEngine?: DecisionEngine;
  /** Opt-in remote decision backend for `thinktrim_rank`. Deterministic by default. */
  readonly decisionBackend?: McpDecisionBackendConfig;
  /** Environment and transport seams for the decision backend (tests only). */
  readonly decisionBackendRuntime?: ComposeDecisionBackendOptions;
}

/** Remote score requests are limited to one provider-sized group of top candidates. */
const REMOTE_RANK_CANDIDATES = 16;

const taskSchema = z.string().trim().min(1).max(2000);
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/^[A-Za-z]:/.test(value) &&
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.split(/[\\/]/).includes("..") &&
      ![...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      }),
    "Expected a safe workspace-relative path",
  );
const boundedId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\r\n\t]+$/);
const evidenceSchema = z
  .object({
    id: boundedId,
    source: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(512),
    fingerprint: z.string().trim().min(1).max(256),
  })
  .strict();

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const conservativeEngine: DecisionEngine = {
  async decide(request) {
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: request.id,
      outcome: "unknown",
      confidence: null,
      calibrated: false,
      provenance: "fallback",
      latencyMs: 0,
      trace: {
        traceId: `mcp-${request.id}`,
        requestId: request.id,
        category: request.category,
        kind: request.kind,
        stages: [],
        cacheHit: false,
        outcome: "unknown",
        reasonCode: "no_calibrated_engine",
        latencyMs: 0,
      },
    };
  },
};

export function createThinkTrimMcpServer(options: ThinkTrimMcpOptions = {}): McpServer {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  let currentIndex: Promise<RepositoryIndex> | undefined;
  let refreshInFlight: Promise<RepositoryIndex> | undefined;
  const server = new McpServer({
    name: "thinktrim",
    version: options.serverVersion ?? "0.1.0",
  });
  const ranker = new ContextRankingPolicy();
  const decision = composeDecisionBackend(options.decisionBackend, options.decisionBackendRuntime);
  const gate = new ContextSufficiencyPolicy({
    engine: options.decisionEngine ?? conservativeEngine,
  });
  const classifier = new FailureClassificationPolicy();

  const refreshIndex = (): Promise<RepositoryIndex> => {
    if (refreshInFlight) return refreshInFlight;
    const pending = indexWorkspace(workspaceRoot);
    currentIndex = pending;
    refreshInFlight = pending;
    void pending
      .catch(() => {
        if (currentIndex === pending) currentIndex = undefined;
      })
      .finally(() => {
        if (refreshInFlight === pending) refreshInFlight = undefined;
      });
    return pending;
  };
  const getIndex = (): Promise<RepositoryIndex> => currentIndex ?? refreshIndex();

  server.registerTool(
    "thinktrim_context",
    {
      description: "Retrieve compact file candidates for a coding task, without source contents.",
      inputSchema: z
        .object({
          task: taskSchema,
          limit: z.number().int().min(1).max(40).optional(),
        })
        .strict(),
    },
    async ({ task, limit }) => {
      const generated = generateCandidates(await getIndex(), task, { maxCandidates: limit ?? 20 });
      return textResult({
        candidates: generated.details.map(({ id, path, description, matchedTerms }) => ({
          id,
          path,
          description,
          matchedTerms,
        })),
        examined: generated.examined,
        truncated: generated.truncated,
      });
    },
  );

  server.registerTool(
    "thinktrim_rank",
    {
      description:
        decision.status.state === "ready"
          ? "Rank workspace file candidates. Ordering is deterministic; the top 16 candidates' task, paths, and symbol/import summaries are also sent to Jev on openrouter.ai for uncalibrated advisory scores."
          : "Rank workspace file candidates deterministically; relevance is not calibrated confidence.",
      inputSchema: z
        .object({
          task: taskSchema,
          limit: z.number().int().min(1).max(40).optional(),
          changedFiles: z.array(relativePathSchema).max(40).optional(),
        })
        .strict(),
    },
    async ({ task, limit, changedFiles }, extra) => {
      const signal = extra.mcpReq.signal;
      const generated = generateCandidates(await getIndex(), task, { maxCandidates: 40 });
      const input = {
        task,
        ...(changedFiles === undefined ? {} : { changedFiles }),
      };
      const result = await ranker.rank({ ...input, candidates: generated.details }, signal);
      const count = limit ?? 20;
      let ranked: readonly RankedContextCandidate[] = result.ranked;
      let confidence = result.confidence;
      let calibrated = result.calibrated;
      let backendReport: Record<string, unknown> = { ...decision.status };
      if (decision.remoteRanker && result.metadata.reasonCode === "deterministic_baseline") {
        const byId = new Map<string, CandidateMetadata>(
          generated.details.map((item) => [item.id, item]),
        );
        const top = result.ranked
          .slice(0, REMOTE_RANK_CANDIDATES)
          .flatMap((item) => byId.get(item.id) ?? []);
        const remote = await decision.remoteRanker.rank(
          {
            ...input,
            candidates: top,
            locality: "remote_allowed",
            allowedRemoteData: decision.allowedRemoteData,
            deadlineMs: 25_000,
          },
          signal,
        );
        if (remote.calibrated) {
          const reordered = new Set(remote.ranked.map((item) => item.id));
          ranked = [...remote.ranked, ...result.ranked.filter((item) => !reordered.has(item.id))];
          confidence = remote.confidence;
          calibrated = true;
        }
        backendReport = {
          ...backendReport,
          source: remote.calibrated ? "backend" : remote.advisory ? "advisory" : "deterministic",
          reasonCode: remote.metadata.reasonCode,
          remoteRequestsAttempted: remote.metadata.requestCount,
          candidatesScored: top.length,
          latencyMs: remote.metadata.latencyMs,
          ...(remote.metadata.usage === undefined ? {} : { usage: remote.metadata.usage }),
          ...(remote.backend === undefined ? {} : { backendIdentity: remote.backend }),
          ...(remote.advisory === undefined
            ? {}
            : {
                advisory: {
                  ...remote.advisory,
                  scores: [...remote.advisory.scores].sort((a, b) => b.score - a.score),
                },
              }),
        };
      }
      return textResult({
        ranked: ranked.slice(0, count),
        confidence,
        calibrated,
        metadata: result.metadata,
        decisionBackend: backendReport,
        truncated: generated.truncated || ranked.length > count,
      });
    },
  );

  server.registerTool(
    "thinktrim_gate",
    {
      description:
        "Assess context sufficiency conservatively; uncertainty permits further retrieval.",
      inputSchema: z
        .object({
          task: taskSchema,
          retrievedEvidence: z.array(evidenceSchema).max(32),
          requiredEvidenceIds: z.array(boundedId).max(32),
          openQuestions: z.array(z.string().trim().min(1).max(256)).max(16).optional(),
          repositoryState: z.string().trim().min(1).max(256).optional(),
        })
        .strict(),
    },
    async (
      { task, retrievedEvidence, requiredEvidenceIds, openQuestions, repositoryState },
      extra,
    ) =>
      textResult(
        await gate.assess(
          {
            task,
            retrievedEvidence,
            requiredEvidenceIds,
            ...(openQuestions === undefined ? {} : { openQuestions }),
            ...(repositoryState === undefined ? {} : { repositoryState }),
          },
          extra.mcpReq.signal,
        ),
      ),
  );

  server.registerTool(
    "thinktrim_classify",
    {
      description: "Classify bounded terminal output after diagnostic normalization.",
      inputSchema: z
        .object({
          output: z.string().max(16_000),
          exitCode: z.number().int().min(-255).max(255).nullable().optional(),
          testName: z.string().trim().min(1).max(256).optional(),
        })
        .strict(),
    },
    async ({ output, exitCode, testName }, extra) =>
      textResult(
        await classifier.classify(
          {
            output,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(testName === undefined ? {} : { testName }),
          },
          extra.mcpReq.signal,
        ),
      ),
  );

  server.registerTool(
    "thinktrim_status",
    {
      title: "ThinkTrim status",
      description: "Show the ThinkTrim MCP server workspace and indexing status.",
      inputSchema: z.object({}).strict(),
    },
    async () =>
      textResult({
        workspaceRoot,
        indexed: currentIndex !== undefined,
        decisionBackend: decision.status,
      }),
  );

  server.registerTool(
    "thinktrim_index_workspace",
    {
      title: "Index workspace",
      description:
        "Refresh the deterministic, ignore-aware workspace index. Only file metadata and fingerprints are retained in memory.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const index = await refreshIndex();
      return textResult({ workspaceRoot: index.root, ...index.stats });
    },
  );

  server.registerTool(
    "thinktrim_search_files",
    {
      title: "Search files",
      description:
        "Find relevant workspace files by lexical match and return paths and compact symbol/import metadata, without source contents.",
      inputSchema: z
        .object({
          query: taskSchema,
          limit: z.number().int().min(1).max(40).optional(),
        })
        .strict(),
    },
    async ({ query, limit }) => {
      const index = await getIndex();
      const hits = index.searchFiles(query, { ...(limit === undefined ? {} : { limit }) });
      return textResult(
        hits.map(({ item, score, matchedTerms }) => ({
          path: item.path,
          language: item.language,
          score,
          matchedTerms,
          symbols: item.symbols.slice(0, 24).map(({ name, kind }) => ({ name, kind })),
          imports: item.imports.slice(0, 24).map(({ specifier, resolvedPath }) => ({
            specifier,
            resolvedPath,
          })),
        })),
      );
    },
  );

  server.registerTool(
    "thinktrim_search_symbols",
    {
      title: "Search symbols",
      description: "Find workspace symbols by name and return their file paths and kinds.",
      inputSchema: z
        .object({
          query: taskSchema,
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    },
    async ({ query, limit }) => {
      const index = await getIndex();
      return textResult(
        index.searchSymbols(query, { ...(limit === undefined ? {} : { limit }) }).map((hit) => ({
          ...hit.item,
          score: hit.score,
        })),
      );
    },
  );

  server.registerTool(
    "thinktrim_get_dependencies",
    {
      title: "Get file dependencies",
      description: "Return indexed workspace dependency and dependent paths for one relative file.",
      inputSchema: z.object({ path: relativePathSchema }).strict(),
    },
    async ({ path }) => {
      const index = await getIndex();
      return textResult({
        path,
        dependencies: index.getDependencies(path),
        dependents: index.getDependents(path),
      });
    },
  );

  return server;
}

export function startThinkTrimMcpServer(options: ThinkTrimMcpOptions = {}): void {
  // stdout carries the MCP protocol; stderr is the host's server log.
  process.stderr.write(
    `${describeDecisionBackend(composeDecisionBackend(options.decisionBackend, options.decisionBackendRuntime).status)}
`,
  );
  serveStdio(() => createThinkTrimMcpServer(options));
}
