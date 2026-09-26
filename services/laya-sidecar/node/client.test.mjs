import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LayaSidecarClient } from "./client.mjs";

const clients = [];
function client(options = {}) {
  const instance = new LayaSidecarClient({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mock-worker.mjs", import.meta.url))],
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    ...options,
  });
  clients.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((instance) => instance.shutdown()));
});

test("reuses one process and shuts it down", async () => {
  const worker = client();
  const first = await worker.request("predict", { state: "one" });
  const second = await worker.request("predict", { state: "two" });
  assert.equal(first.pid, second.pid);
  assert.deepEqual(second.echo, { state: "two" });
  await worker.shutdown();
  assert.equal(worker.process, null);
});

test("restarts after crash and invalid JSON", async () => {
  const worker = client();
  const before = await worker.request("predict", {});
  await assert.rejects(worker.request("crash"), { code: "crash" });
  const afterCrash = await worker.request("predict", {});
  assert.notEqual(afterCrash.pid, before.pid);
  await assert.rejects(worker.request("invalidJson"), { code: "invalid_json" });
  const afterInvalid = await worker.request("predict", {});
  assert.notEqual(afterInvalid.pid, afterCrash.pid);
});

test("times out, cancels, and drains stderr without exposing content", async () => {
  const diagnostics = [];
  const worker = client({ requestTimeoutMs: 40, onDiagnostic: (event) => diagnostics.push(event) });
  await assert.rejects(worker.request("hang"), { code: "timeout" });
  const controller = new AbortController();
  const pending = worker.request("hang", undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: "cancelled" });
  await worker.request("stderr");
  assert.ok(diagnostics.some((event) => event.kind === "stderr" && event.bytes > 0));
  assert.ok(diagnostics.every((event) => !Object.hasOwn(event, "content")));
});

test("bounds startup and rejects cyclic input", async () => {
  const stuck = client({ startupTimeoutMs: 40, env: { THINKTRIM_MOCK_HANG_HEALTH: "1" } });
  await assert.rejects(stuck.start(), { code: "timeout" });
  assert.equal(stuck.process, null);

  const worker = client();
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(worker.request("predict", cyclic), { code: "invalid_request" });
  assert.ok((await worker.request("predict", {})).pid > 0);
});
