import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { LayaSidecarClient } from "./client.mjs";

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
    p95Ms: Number(
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(2),
    ),
  };
};
const worker = new LayaSidecarClient({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mock-worker.mjs", import.meta.url))],
  startupTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
});
const cpuBefore = process.cpuUsage();
const memoryBefore = process.memoryUsage();
try {
  const coldStart = performance.now();
  await worker.start();
  const coldStartMs = performance.now() - coldStart;
  const values = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    await worker.request("predict", { state: "profile", sequence: index });
    values.push(performance.now() - start);
  }
  const memoryAfter = process.memoryUsage();
  const cpu = process.cpuUsage(cpuBefore);
  process.stdout.write(
    JSON.stringify({
      worker: "Node mock JSONL worker; it does not load or run Laya",
      coldProcessAndHealthMs: Number(coldStartMs.toFixed(2)),
      warmRpc: summarize(values),
      processReuse: worker.process !== null,
      clientProcess: {
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        heapBeforeBytes: memoryBefore.heapUsed,
        heapAfterBytes: memoryAfter.heapUsed,
        userCpuMs: Number((cpu.user / 1000).toFixed(2)),
        systemCpuMs: Number((cpu.system / 1000).toFixed(2)),
      },
    }) + "\n",
  );
} finally {
  await worker.shutdown();
}
