#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadTasks, runBenchmark } from "./harness.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  if (!["plan", "smoke", "run"].includes(command))
    throw new TypeError("Expected plan, smoke, or run");
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--allow-remote") options.allowRemote = true;
    else if (flag === "--allow-laya") options.allowLaya = true;
    else if (flag === "--keep-workspaces") options.keepWorkspaces = true;
    else if (
      [
        "--tasks",
        "--arms",
        "--max-trials",
        "--seed",
        "--model",
        "--device",
        "--timeout-ms",
        "--decision-timeout-ms",
        "--output",
        "--codex-command",
      ].includes(flag)
    ) {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${flag}`);
      if (flag === "--tasks") options.taskIds = value === "all" ? "all" : value.split(",");
      if (flag === "--arms") options.arms = value.split(",").map((item) => item.toUpperCase());
      if (flag === "--max-trials") options.maxTrials = Number(value);
      if (flag === "--seed") options.seed = Number(value);
      if (flag === "--model") options.model = value;
      if (flag === "--device") options.device = value;
      if (flag === "--timeout-ms") options.timeoutMs = Number(value);
      if (flag === "--decision-timeout-ms") options.decisionTimeoutMs = Number(value);
      if (flag === "--output") options.output = value;
      if (flag === "--codex-command") options.codexCommand = value;
    } else throw new TypeError(`Unknown option: ${flag}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const tasks = await loadTasks();
  if (options.taskIds === "all") options.taskIds = tasks.map((task) => task.id);
  const selected = options.taskIds?.length
    ? tasks.filter((task) => options.taskIds.includes(task.id))
    : tasks.slice(0, 1);
  if (selected.length !== (options.taskIds?.length ?? 1)) throw new TypeError("Unknown task ID");
  const arms = options.arms ?? ["A", "B", "C", "D"];
  const plannedTrials = selected.length * arms.length;
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify(
        {
          tasks: selected.map((task) => ({ id: task.id, category: task.category })),
          arms,
          plannedTrials,
          defaultTrialCap: 4,
          remoteEnabled: Boolean(options.allowRemote),
          layaEnabled: Boolean(options.allowLaya),
          jevCredentialPresent: Boolean(process.env.OPENROUTER_API_KEY),
          layaAvailability: "checked_at_run_time",
          frontierUsage: "measured_only_when_agent_emits_usage",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "smoke") {
    if (selected.some((task) => task.id !== "bug-fix")) {
      throw new TypeError("The quota-free smoke agent supports only bug-fix");
    }
    options.agent = "mock";
    options.allowRemote = true;
  } else {
    if (!options.model) throw new TypeError("A live run requires --model for paired comparisons");
    options.agent = "codex";
  }
  const report = await runBenchmark(options);
  const destination = path.resolve(
    root,
    options.output ?? `benchmarks/results/${command}-${Date.now()}.json`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        report: destination,
        agent: report.agent,
        trials: plannedTrials,
        summary: report.summary,
        outcomes: report.records.map((record) => ({
          taskId: record.taskId,
          arm: record.arm,
          status: record.status,
          taskSuccess: record.taskSuccess,
          reason: record.reason ?? null,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`benchmark: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
