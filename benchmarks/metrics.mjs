import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function runProcess(command, args, { cwd, input, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      output.push(chunk);
    });
    // Drain stderr, but do not persist it: it may contain repository text or credentials.
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        timedOut,
        outputExceeded,
        stdout: Buffer.concat(output).toString("utf8"),
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

function usageNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function commandKind(command) {
  if (typeof command !== "string") return { read: 0, search: 0 };
  const text = command.toLowerCase();
  return {
    read: /\b(cat|type|get-content|sed|head|tail|more)\b/.test(text) ? 1 : 0,
    search: /\b(rg|grep|findstr|select-string|git grep)\b/.test(text) ? 1 : 0,
  };
}

/** Parses only stable, explicit Codex JSONL fields. Missing usage remains null. */
export function parseCodexEvents(stdout) {
  let frontierInputTokens = 0;
  let frontierOutputTokens = 0;
  let usageEvents = 0;
  let agentTurns = 0;
  let fileReads = 0;
  let searches = 0;
  let finalAnswer = "";
  let failed = false;
  const tools = new Set();
  const commandItems = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "turn.completed") {
      agentTurns += 1;
      const input = usageNumber(event.usage?.input_tokens);
      const output = usageNumber(event.usage?.output_tokens);
      if (input !== null && output !== null) {
        frontierInputTokens += input;
        frontierOutputTokens += output;
        usageEvents += 1;
      }
    }
    if (event?.type === "turn.failed") failed = true;
    if ((event?.type === "item.started" || event?.type === "item.completed") && event.item) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalAnswer = item.text;
      }
      if (item.type === "command_execution" || item.type === "mcp_tool_call") {
        const id = typeof item.id === "string" ? item.id : `${event.type}:${tools.size}`;
        tools.add(id);
        if (item.type === "command_execution" && !commandItems.has(id)) {
          commandItems.add(id);
          const kind = commandKind(item.command);
          fileReads += kind.read;
          searches += kind.search;
        }
      }
    }
  }
  return {
    frontierInputTokens: usageEvents ? frontierInputTokens : null,
    frontierOutputTokens: usageEvents ? frontierOutputTokens : null,
    frontierTotalTokens: usageEvents ? frontierInputTokens + frontierOutputTokens : null,
    usageSource: usageEvents ? "codex_turn_completed" : null,
    agentTurns,
    toolCalls: tools.size,
    fileReads,
    searches,
    commandCountMethod: "observed_command_heuristic",
    finalAnswer,
    failed,
  };
}

export function summarize(records) {
  const arms = ["A", "B", "C", "D"];
  return Object.fromEntries(
    arms.map((arm) => {
      const runs = records.filter((record) => record.arm === arm);
      const attempted = runs.filter(
        (record) => record.status === "completed" || record.status === "agent_error",
      );
      const successes = attempted.filter((record) => record.taskSuccess);
      const allUsageMeasured =
        !runs.some((record) => record.status === "harness_error") &&
        attempted.every(
          (record) =>
            record.frontierTotalTokens !== null && record.frontierTotalTokens !== undefined,
        );
      const tokens = attempted.reduce(
        (total, record) => total + (record.frontierTotalTokens ?? 0),
        0,
      );
      return [
        arm,
        {
          planned: runs.length,
          attempted: attempted.length,
          completed: runs.filter((record) => record.status === "completed").length,
          skipped: runs.filter((record) => record.status === "skipped").length,
          successful: successes.length,
          successRate: attempted.length ? successes.length / attempted.length : null,
          frontierTokensPerSuccessfulTask:
            successes.length && allUsageMeasured ? tokens / successes.length : null,
          metricSource: successes.length && allUsageMeasured ? "measured_frontier" : "unavailable",
        },
      ];
    }),
  );
}
