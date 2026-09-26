import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { indexWorkspace } from "../dist/index.js";

const sizes = [
  ["small", 25],
  ["medium", 500],
  ["large", 5000],
];

for (const [name, fileCount] of sizes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-index-bench-"));
  try {
    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    for (let directory = 0; directory < Math.ceil(fileCount / 100); directory++) {
      await mkdir(path.join(root, "src", `part-${directory}`), { recursive: true });
    }
    for (let i = 0; i < fileCount; i++) {
      const dir = `part-${Math.floor(i / 100)}`;
      const previous =
        i % 100 === 0 ? "" : `import { computeWidget${i - 1} } from './file-${i - 1}';\n`;
      const body = `${previous}export function computeWidget${i}() { return ${i}; }\n`;
      await writeFile(path.join(root, "src", dir, `file-${i}.ts`), body);
    }
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    const index = await indexWorkspace(root);
    const initialMs = performance.now() - start;
    const afterIndexMemory = process.memoryUsage();
    const afterIndexCpu = process.cpuUsage(cpuBefore);
    const searchStart = performance.now();
    for (let i = 0; i < 100; i++)
      index.searchFiles(`compute widget ${i % fileCount}`, { limit: 20 });
    const searchMs = performance.now() - searchStart;
    const cpuBeforeRefresh = process.cpuUsage();
    const refreshStart = performance.now();
    const refreshed = await index.refresh();
    const refreshMs = performance.now() - refreshStart;
    const afterRefreshMemory = process.memoryUsage();
    const afterRefreshCpu = process.cpuUsage(cpuBeforeRefresh);
    process.stdout.write(
      JSON.stringify({
        fixture: name,
        files: fileCount,
        indexed: index.files.size,
        initialMs: Math.round(initialMs),
        search100Ms: Math.round(searchMs),
        refreshMs: Math.round(refreshMs),
        reused: refreshed.stats.reused,
        process: {
          rssBeforeBytes: memoryBefore.rss,
          rssAfterIndexBytes: afterIndexMemory.rss,
          rssAfterRefreshBytes: afterRefreshMemory.rss,
          heapUsedBeforeBytes: memoryBefore.heapUsed,
          heapUsedAfterIndexBytes: afterIndexMemory.heapUsed,
          heapUsedAfterRefreshBytes: afterRefreshMemory.heapUsed,
          cpuAfterIndexMs: Math.round((afterIndexCpu.user + afterIndexCpu.system) / 1000),
          cpuDuringRefreshMs: Math.round((afterRefreshCpu.user + afterRefreshCpu.system) / 1000),
        },
      }) + "\n",
    );
  } finally {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}
