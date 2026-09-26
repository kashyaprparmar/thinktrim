import { spawn } from "node:child_process";
import { dirname } from "node:path";

const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_CWD = dirname(process.execPath);

export class SidecarError extends Error {
  constructor(code) {
    super(code);
    this.name = "SidecarError";
    this.code = code;
  }
}

/** Owns one persistent JSONL worker; a failed worker is restarted on the next request. */
export class LayaSidecarClient {
  constructor({
    command = "python",
    args = ["-I", "-u", "-m", "thinktrim_laya_sidecar"],
    cwd = DEFAULT_CWD,
    env,
    startupTimeoutMs = 30_000,
    requestTimeoutMs = 30_000,
    shutdownTimeoutMs = 2_000,
    onDiagnostic = () => {},
  } = {}) {
    this.options = {
      command,
      args,
      cwd,
      env,
      startupTimeoutMs,
      requestTimeoutMs,
      shutdownTimeoutMs,
    };
    this.onDiagnostic = onDiagnostic;
    this.process = null;
    this.starting = null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.generation = 0;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.process) return;
    this.starting = this.#spawnAndProbe();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #spawnAndProbe() {
    const { command, args, cwd, env, startupTimeoutMs } = this.options;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.buffer = Buffer.alloc(0);
    const generation = ++this.generation;
    child.stdout.on("data", (chunk) => this.#read(chunk, generation));
    child.stderr.on("data", (chunk) => {
      try {
        this.onDiagnostic({ kind: "stderr", bytes: chunk.length });
      } catch {
        // A diagnostic observer must not stop protocol processing.
      }
    });
    child.stdin.on("error", () => this.#fail(new SidecarError("crash"), generation));
    child.on("error", () => this.#fail(new SidecarError("startup_failed"), generation));
    child.on("exit", () => this.#fail(new SidecarError("crash"), generation));
    const health = await this.#send("health", undefined, { timeoutMs: startupTimeoutMs });
    if (!health || !["ready", "model_unavailable"].includes(health.status)) {
      this.#fail(new SidecarError("invalid_json"), generation);
      throw new SidecarError("invalid_json");
    }
  }

  #fail(error, generation = this.generation) {
    if (generation !== this.generation) return;
    const child = this.process;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    if (child && !child.killed) child.kill();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #read(chunk, generation) {
    if (generation !== this.generation) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes(10)) {
      this.#fail(new SidecarError("invalid_json"), generation);
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_FRAME_BYTES) {
        this.#fail(new SidecarError("invalid_json"), generation);
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let frame;
      try {
        frame = JSON.parse(line.toString("utf8"));
      } catch {
        this.#fail(new SidecarError("invalid_json"), generation);
        return;
      }
      if (frame?.v !== 1 || typeof frame.id !== "string" || typeof frame.ok !== "boolean") {
        this.#fail(new SidecarError("invalid_json"), generation);
        return;
      }
      const entry = this.pending.get(frame.id);
      if (!entry) {
        this.#fail(new SidecarError("invalid_json"), generation);
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.abort);
      if (frame.ok) entry.resolve(frame.result);
      else entry.reject(new SidecarError(frame.error?.code ?? "backend_failure"));
    }
    if (this.buffer.length > MAX_FRAME_BYTES)
      this.#fail(new SidecarError("invalid_json"), generation);
  }

  #send(op, params, { signal, timeoutMs = this.options.requestTimeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(new SidecarError("cancelled"));
    if (!this.process || this.pending.size >= 32) {
      return Promise.reject(new SidecarError("unavailable"));
    }
    const id = String(++this.nextId);
    let frame;
    try {
      frame = JSON.stringify({ v: 1, id, op, ...(params === undefined ? {} : { params }) }) + "\n";
    } catch {
      return Promise.reject(new SidecarError("invalid_request"));
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new SidecarError("invalid_request"));
    }
    return new Promise((resolve, reject) => {
      const abort = () => this.#fail(new SidecarError("cancelled"));
      const timer = setTimeout(() => this.#fail(new SidecarError("timeout")), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      this.process.stdin.write(frame, (error) => {
        if (error) this.#fail(new SidecarError("crash"));
      });
    });
  }

  async request(op, params, options) {
    if (options?.signal?.aborted) throw new SidecarError("cancelled");
    const abort = () => this.#fail(new SidecarError("cancelled"));
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.start();
    } finally {
      options?.signal?.removeEventListener("abort", abort);
    }
    if (options?.signal?.aborted) throw new SidecarError("cancelled");
    return this.#send(op, params, options);
  }

  async shutdown() {
    if (!this.process) return;
    const child = this.process;
    let timer;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await this.#send("shutdown", undefined, { timeoutMs: this.options.shutdownTimeoutMs });
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.options.shutdownTimeoutMs);
        }),
      ]);
    } catch {
      // A stuck worker is terminated below.
    } finally {
      clearTimeout(timer);
    }
    if (this.process === child) this.#fail(new SidecarError("shutdown"));
  }
}
