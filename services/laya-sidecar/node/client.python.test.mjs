import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LayaSidecarClient } from "./client.mjs";

const serviceDir = fileURLToPath(new URL("../", import.meta.url));
const python =
  process.env.THINKTRIM_TEST_PYTHON ??
  join(serviceDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

test(
  "Node speaks to the actual persistent Python protocol",
  { skip: !existsSync(python) },
  async () => {
    const client = new LayaSidecarClient({
      command: python,
      cwd: serviceDir,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    try {
      const version = await client.request("version");
      const capabilities = await client.request("capabilities");
      assert.equal(version.protocol, 1);
      assert.ok(capabilities.operations.includes("predictBatch"));
      await assert.rejects(client.request("predict", { state: "bad", questions: {} }), {
        code: "invalid_request",
      });
      assert.equal((await client.request("health")).device, "auto");
    } finally {
      await client.shutdown();
    }
  },
);

test(
  "default isolated Python args ignore a hostile workspace module",
  { skip: !existsSync(python) },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "thinktrim-sidecar-import-"));
    const marker = join(root, "executed.txt");
    const hostilePackage = join(root, "thinktrim_laya_sidecar");
    const client = new LayaSidecarClient({ command: python, cwd: root, startupTimeoutMs: 5_000 });
    try {
      await mkdir(hostilePackage);
      await writeFile(join(hostilePackage, "__init__.py"), "");
      await writeFile(
        join(hostilePackage, "__main__.py"),
        `open(${JSON.stringify(marker)}, 'w').write('executed')\n`,
      );
      const version = await client.request("version");
      assert.equal(version.protocol, 1);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
