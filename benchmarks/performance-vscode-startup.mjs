import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";

const require = createRequire(import.meta.url);
const extensionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../apps/vscode-extension/dist/extension.cjs",
);
const makeDisposable = () => ({ dispose() {} });
const vscode = {
  StatusBarAlignment: { Left: 1 },
  TreeItemCollapsibleState: { None: 0 },
  TreeItem: class TreeItem {},
  EventEmitter: class EventEmitter {
    event = () => makeDisposable();
    fire() {}
    dispose() {}
  },
  window: {
    createOutputChannel: () => ({ info() {}, warn() {}, error() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerTreeDataProvider: () => makeDisposable(),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    onDidChangeConfiguration: () => makeDisposable(),
  },
  commands: { registerCommand: () => makeDisposable() },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const durations = [];
  for (let sample = 0; sample < 15; sample++) {
    delete require.cache[extensionPath];
    const context = {
      subscriptions: [],
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => makeDisposable(),
      },
    };
    const start = performance.now();
    require(extensionPath).activate(context);
    durations.push(performance.now() - start);
    for (const subscription of context.subscriptions) subscription.dispose();
  }
  durations.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      measurement:
        "module load + activate using a minimal VS Code API shim; not Extension Development Host startup",
      bundleBytes: statSync(extensionPath).size,
      samples: durations.length,
      p50Ms: Number(durations[Math.floor(durations.length / 2)].toFixed(2)),
      p95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(2)),
    }) + "\n",
  );
} finally {
  Module._load = originalLoad;
}
