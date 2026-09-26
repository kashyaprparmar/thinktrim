import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixture } from "./fixtures.mjs";
import { loadTasks, runBenchmark, runTrial } from "./harness.mjs";
import { parseCodexEvents, summarize } from "./metrics.mjs";

test("catalog covers the ten requested task categories", async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((task) => task.category)).size, 10);
});

test("every catalog task has an isolated fixture with its target source", async () => {
  const tasks = await loadTasks();
  for (const task of tasks) {
    const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-bench-test-"));
    try {
      await createFixture(task.id, root);
      await access(path.join(root, "package.json"));
      for (const file of task.expectedFiles) {
        if (task.id !== "test-addition") await access(path.join(root, file));
      }
      if (task.id === "large-repository-task") {
        await access(path.join(root, "src/modules/module-000.mjs"));
        await access(path.join(root, "src/modules/module-299.mjs"));
      }
    } finally {
      assert.equal(path.dirname(root), os.tmpdir());
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Codex JSONL parser records only explicit frontier usage and observed commands", () => {
  const events = [
    {
      type: "item.started",
      item: { id: "one", type: "command_execution", command: "rg refresh src" },
    },
    {
      type: "item.completed",
      item: { id: "one", type: "command_execution", command: "rg refresh src" },
    },
    {
      type: "item.completed",
      item: { id: "two", type: "command_execution", command: "cat src/math.mjs" },
    },
    { type: "item.completed", item: { id: "three", type: "agent_message", text: "Fixed." } },
    { type: "turn.completed", usage: { input_tokens: 120, output_tokens: 30 } },
  ];
  const parsed = parseCodexEvents(events.map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(parsed.frontierTotalTokens, 150);
  assert.equal(parsed.searches, 1);
  assert.equal(parsed.fileReads, 1);
  assert.equal(parsed.toolCalls, 2);
  assert.equal(parsed.agentTurns, 1);
  assert.equal(parsed.finalAnswer, "Fixed.");
  assert.equal(parseCodexEvents('{"type":"turn.completed"}').frontierTotalTokens, null);
});

test("primary metric includes token cost of failed attempts", () => {
  const summary = summarize([
    { arm: "A", status: "completed", taskSuccess: true, frontierTotalTokens: 100 },
    { arm: "A", status: "agent_error", taskSuccess: false, frontierTotalTokens: 50 },
    { arm: "B", status: "completed", taskSuccess: true, frontierTotalTokens: null },
  ]);
  assert.equal(summary.A.frontierTokensPerSuccessfulTask, 150);
  assert.equal(summary.A.successRate, 0.5);
  assert.equal(summary.B.frontierTokensPerSuccessfulTask, null);
});

test("quota-free smoke exercises four isolated arms without claiming frontier tokens", async () => {
  const report = await runBenchmark({
    agent: "mock",
    taskIds: ["bug-fix"],
    arms: ["A", "B", "C", "D"],
    maxTrials: 4,
    seed: 29,
  });
  assert.equal(report.records.length, 4);
  assert.deepEqual(
    new Set(report.records.map((record) => record.arm)),
    new Set(["A", "B", "C", "D"]),
  );
  for (const record of report.records) {
    assert.equal(record.status, "completed");
    assert.equal(record.taskSuccess, true);
    assert.equal(record.testsPassed, true);
    assert.equal(record.testsRun, 1);
    assert.equal(record.patchCorrect, true);
    assert.equal(record.frontierTotalTokens, null);
  }
  assert.equal(report.summary.A.frontierTokensPerSuccessfulTask, null);
  assert.equal(report.records.find((record) => record.arm === "C").experimentalUncalibrated, true);
});

test("remote arm is skipped explicitly when remote inference is not enabled", async () => {
  const [task] = await loadTasks();
  const record = await runTrial(task, "D", { agent: "codex", allowRemote: false });
  assert.equal(record.status, "skipped");
  assert.equal(record.reason, "remote_provider_not_enabled");
});

test("local model arm is skipped explicitly until enabled", async () => {
  const [task] = await loadTasks();
  const record = await runTrial(task, "C", { agent: "codex", allowLaya: false });
  assert.equal(record.status, "skipped");
  assert.equal(record.reason, "local_provider_not_enabled");
});
