import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CONTRACT_SCHEMA_VERSION } from "../packages/core/dist/index.js";
import { ContextRankingPolicy, generateCandidates } from "../packages/context-ranker/dist/index.js";
import { indexWorkspace } from "../packages/repo-indexer/dist/index.js";
import { JevBackend, LayaLocalBackend } from "../packages/providers/dist/index.js";
import { createFixture } from "./fixtures.mjs";
import { gradeTask } from "./grade.mjs";
import { parseCodexEvents, runProcess, summarize } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARMS = ["A", "B", "C", "D"];

export async function loadTasks() {
  const tasks = JSON.parse(await readFile(path.join(here, "tasks.json"), "utf8"));
  if (!Array.isArray(tasks) || tasks.length !== 10) throw new Error("Expected ten benchmark tasks");
  const categories = new Set(tasks.map((task) => task.category));
  if (categories.size !== 10 || new Set(tasks.map((task) => task.id)).size !== 10) {
    throw new Error("Benchmark task IDs and categories must be unique");
  }
  return tasks;
}

function safeReason(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code && /^[a-z_]{1,40}$/i.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 40) : "unavailable";
}

function scoreBackendFor(arm, options) {
  if (options.providerFactory) return options.providerFactory(arm);
  if (options.agent === "mock") {
    return {
      capabilities: { id: "fixture-score", modelVersion: "simulated", locality: "local" },
      health: async () => "healthy",
      predict: async (request) => ({
        value: {
          kind: "score",
          scores: request.candidates.map((candidate, index) => ({
            id: candidate.id,
            score: 1 - index / Math.max(1, request.candidates.length),
          })),
        },
      }),
    };
  }
  if (arm === "C") {
    if (!options.allowLaya) return null;
    return new LayaLocalBackend({ device: options.device ?? "cpu" });
  }
  if (!options.allowRemote) return null;
  if (!process.env.OPENROUTER_API_KEY) return null;
  return new JevBackend({ timeoutMs: options.decisionTimeoutMs ?? 30_000 });
}

async function prepareContext(task, root, arm, options) {
  if (arm === "A") {
    return {
      selected: [],
      contextMode: "agent_alone",
      candidateCount: 0,
      retrievalLatencyMs: 0,
      decisionLatencyMs: 0,
      decisionBackendUsage: null,
      experimentalUncalibrated: false,
    };
  }
  const retrievalStart = performance.now();
  const index = await indexWorkspace(root);
  const generated = generateCandidates(index, task.prompt, { maxCandidates: 30 });
  const deterministic = await new ContextRankingPolicy().rank({
    task: task.prompt,
    candidates: generated.details,
  });
  const retrievalLatencyMs = performance.now() - retrievalStart;
  const byId = new Map(generated.details.map((item) => [item.id, item]));
  let ordering = deterministic.ranked.map((item) => item.id);
  let decisionLatencyMs = 0;
  let decisionBackendUsage = null;
  let backendId = null;
  let modelVersion = null;
  if (arm === "C" || arm === "D") {
    const backend = await scoreBackendFor(arm, options);
    if (!backend) {
      return {
        skipped: arm === "D" ? "remote_provider_not_enabled" : "local_provider_not_enabled",
      };
    }
    const scoreStart = performance.now();
    try {
      if ((await backend.health()) === "unavailable") return { skipped: "provider_unavailable" };
      const shortlisted = ordering.slice(0, 16);
      if (shortlisted.length === 0) return { skipped: "no_candidates" };
      const candidates = shortlisted.map((id) =>
        generated.candidates.find((item) => item.id === id),
      );
      if (candidates.some((item) => !item)) return { skipped: "candidate_mapping_failed" };
      const request = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        id: `benchmark-${arm}-${createHash("sha256").update(task.id).digest("hex").slice(0, 16)}`,
        category: "context_ranking",
        kind: "score",
        task: task.prompt,
        candidates,
        dataClasses: ["task", "paths", "summaries"],
        constraints: {
          locality: arm === "D" ? "remote_allowed" : "local_only",
          allowedRemoteData: arm === "D" ? ["task", "paths", "summaries"] : [],
          profile: "safe",
          deadlineMs: options.decisionTimeoutMs ?? 30_000,
          maxCandidates: candidates.length,
          maxOutputItems: candidates.length,
        },
      };
      const prediction = await backend.predict(request);
      if (prediction.value?.kind !== "score") return { skipped: "invalid_provider_scores" };
      const scores = new Map(prediction.value.scores.map((item) => [item.id, item.score]));
      if (
        scores.size !== shortlisted.length ||
        shortlisted.some(
          (id) => !Number.isFinite(scores.get(id)) || scores.get(id) < 0 || scores.get(id) > 1,
        )
      ) {
        return { skipped: "invalid_provider_scores" };
      }
      const position = new Map(ordering.map((id, index) => [id, index]));
      ordering = [
        ...shortlisted.sort(
          (left, right) =>
            scores.get(right) - scores.get(left) || position.get(left) - position.get(right),
        ),
        ...ordering.slice(16),
      ];
      decisionBackendUsage = prediction.usage ?? null;
      backendId = backend.capabilities.id;
      modelVersion = backend.capabilities.modelVersion;
    } catch (error) {
      return { skipped: safeReason(error) };
    } finally {
      decisionLatencyMs = performance.now() - scoreStart;
      if (typeof backend.shutdown === "function") {
        try {
          await backend.shutdown();
        } catch {
          // A failed shutdown cannot convert the unavailable model into a benchmark result.
        }
      }
    }
  }
  return {
    selected: ordering
      .slice(0, 6)
      .map((id) => byId.get(id))
      .filter(Boolean),
    contextMode: arm === "B" ? "deterministic" : "experimental_provider_order",
    candidateCount: generated.details.length,
    retrievalLatencyMs,
    decisionLatencyMs,
    decisionBackendUsage,
    backendId,
    modelVersion,
    experimentalUncalibrated: arm === "C" || arm === "D",
  };
}

function promptFor(task, context) {
  const common = [
    "Work in this benchmark fixture repository. Follow the task exactly and run its tests when requested.",
    "If you cannot complete it, explain what blocked you. Keep the final answer concise.",
    `Task: ${task.prompt}`,
  ];
  if (context.selected.length) {
    common.push(
      "Initial context hints from ThinkTrim (metadata only; search further whenever needed):",
      ...context.selected.map((item) => `- ${item.description}`),
    );
  }
  return common.join("\n\n");
}

async function mockAgent(task, root) {
  if (task.id !== "bug-fix") throw new Error("Mock agent supports only the bug-fix smoke task");
  await writeFile(path.join(root, "src/math.mjs"), "export function sum(a, b) { return a + b; }\n");
  return {
    exitCode: 0,
    failed: false,
    finalAnswer: "Fixed sum and ran the tests.",
    frontierInputTokens: null,
    frontierOutputTokens: null,
    frontierTotalTokens: null,
    usageSource: null,
    agentTurns: 1,
    toolCalls: 1,
    fileReads: 0,
    searches: 0,
    commandCountMethod: "simulated",
  };
}

async function codexAgent(task, root, prompt, options) {
  const args = ["exec", "--approve-for-me", "--ephemeral", "--cd", root, "--json"];
  if (options.model) args.push("--model", options.model);
  args.push("-");
  const result = await runProcess(options.codexCommand ?? "codex", args, {
    cwd: root,
    input: prompt,
    timeoutMs: options.timeoutMs ?? 180_000,
  });
  return {
    ...parseCodexEvents(result.stdout),
    exitCode: result.exitCode,
    failed: result.timedOut || result.outputExceeded,
    timeout: result.timedOut,
    outputExceeded: result.outputExceeded,
  };
}

async function git(root, args) {
  const result = await runProcess("git", args, { cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trimEnd();
}

async function makeCheckout(task) {
  const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-bench-"));
  try {
    await createFixture(task.id, root);
    await git(root, ["init", "-q"]);
    await git(root, ["add", "--all"]);
    await git(root, [
      "-c",
      "user.name=ThinkTrim Benchmark",
      "-c",
      "user.email=benchmark@localhost",
      "commit",
      "-qm",
      "baseline",
    ]);
    return root;
  } catch (error) {
    await cleanCheckout(root, false);
    throw error;
  }
}

async function cleanCheckout(root, keep) {
  if (keep) return;
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("thinktrim-bench-")) {
    throw new Error("Refusing to remove an unexpected benchmark directory");
  }
  await rm(resolved, { recursive: true, force: true });
}

function changedPaths(status) {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replaceAll("\\", "/"))
    .sort();
}

function testCounts(stdout) {
  const value = (name) => {
    const match = stdout.match(new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  return {
    testsRun: value("tests"),
    testsPassedCount: value("pass"),
    testsFailedCount: value("fail"),
  };
}

export async function runTrial(task, arm, options) {
  if (!ARMS.includes(arm)) throw new TypeError(`Unknown arm: ${arm}`);
  const root = await makeCheckout(task);
  const taskStarted = performance.now();
  try {
    const context = await prepareContext(task, root, arm, options);
    if (context.skipped) {
      return {
        taskId: task.id,
        category: task.category,
        arm,
        status: "skipped",
        reason: context.skipped,
        taskSuccess: false,
        frontierTotalTokens: null,
        wallTimeMs: performance.now() - taskStarted,
      };
    }
    const prompt = promptFor(task, context);
    const agentStarted = performance.now();
    const agent =
      options.agent === "mock"
        ? await mockAgent(task, root)
        : await codexAgent(task, root, prompt, options);
    const agentLatencyMs = performance.now() - agentStarted;
    const wallTimeMs = performance.now() - taskStarted;
    const changedFiles = changedPaths(
      await git(root, ["status", "--porcelain", "--untracked-files=all"]),
    );
    const patchCheck = await runProcess("git", ["diff", "--check"], {
      cwd: root,
      timeoutMs: 10_000,
    });
    const testEnv = { ...process.env };
    delete testEnv.NODE_TEST_CONTEXT;
    const testRun = task.tests
      ? await runProcess(process.execPath, ["--test", "--test-reporter=tap"], {
          cwd: root,
          env: testEnv,
          timeoutMs: 30_000,
        })
      : null;
    const testsPassed = testRun === null ? null : testRun.exitCode === 0 && !testRun.timedOut;
    const counts =
      testRun === null
        ? { testsRun: null, testsPassedCount: null, testsFailedCount: null }
        : testCounts(testRun.stdout);
    const grade = await gradeTask(
      task,
      root,
      changedFiles,
      agent.finalAnswer,
      patchCheck.exitCode === 0,
    );
    const taskSuccess =
      agent.exitCode === 0 &&
      !agent.failed &&
      testsPassed !== false &&
      grade.patchCorrect &&
      grade.hiddenCheckPassed;
    return {
      taskId: task.id,
      category: task.category,
      arm,
      status: agent.exitCode === 0 && !agent.failed ? "completed" : "agent_error",
      taskSuccess,
      testsPassed,
      ...counts,
      patchCorrect: grade.patchCorrect,
      hiddenCheckPassed: grade.hiddenCheckPassed,
      gradeIssue: grade.issue,
      changedFileCount: changedFiles.length,
      expectedFileCount: task.expectedFiles.length,
      frontierInputTokens: agent.frontierInputTokens,
      frontierOutputTokens: agent.frontierOutputTokens,
      frontierTotalTokens: agent.frontierTotalTokens,
      usageSource: agent.usageSource,
      agentTurns: agent.agentTurns,
      fileReads: agent.fileReads,
      searches: agent.searches,
      toolCalls: agent.toolCalls,
      commandCountMethod: agent.commandCountMethod,
      wallTimeMs,
      agentLatencyMs,
      retrievalLatencyMs: context.retrievalLatencyMs,
      decisionLatencyMs: context.decisionLatencyMs,
      decisionBackendUsage: context.decisionBackendUsage,
      backendId: context.backendId ?? null,
      modelVersion: context.modelVersion ?? null,
      contextMode: context.contextMode,
      contextCandidateCount: context.candidateCount,
      selectedCandidateCount: context.selected.length,
      experimentalUncalibrated: context.experimentalUncalibrated,
    };
  } finally {
    await cleanCheckout(root, options.keepWorkspaces);
  }
}

function shuffle(items, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export async function runBenchmark(options = {}) {
  const tasks = await loadTasks();
  const selected = options.taskIds?.length
    ? tasks.filter((task) => options.taskIds.includes(task.id))
    : tasks.slice(0, 1);
  if (selected.length !== (options.taskIds?.length ?? 1)) throw new TypeError("Unknown task ID");
  const arms = options.arms ?? ARMS;
  if (!arms.length || arms.some((arm) => !ARMS.includes(arm))) throw new TypeError("Invalid arms");
  const seed = options.seed ?? 29;
  const trials = selected.flatMap((task) =>
    shuffle(arms, seed + tasks.indexOf(task)).map((arm) => ({ task, arm })),
  );
  const maxTrials = options.maxTrials ?? 4;
  if (!Number.isSafeInteger(maxTrials) || maxTrials < 1 || maxTrials > 100) {
    throw new RangeError("maxTrials must be between 1 and 100");
  }
  if (trials.length > maxTrials)
    throw new RangeError(`Requested ${trials.length} trials; maxTrials is ${maxTrials}`);
  const startedAt = new Date().toISOString();
  const records = [];
  for (const { task, arm } of trials) {
    try {
      records.push(await runTrial(task, arm, options));
    } catch (error) {
      records.push({
        taskId: task.id,
        category: task.category,
        arm,
        status: "harness_error",
        reason: safeReason(error),
        taskSuccess: false,
        frontierTotalTokens: null,
      });
    }
  }
  return {
    schemaVersion: 1,
    startedAt,
    agent: options.agent ?? "codex",
    model: options.model ?? null,
    seed,
    records,
    summary: summarize(records),
  };
}
