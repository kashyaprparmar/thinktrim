import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createLocalTraceRecord } from "./record.js";
import type { LocalTraceInput, LocalTraceRecord } from "./record.js";

const TRACE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const MAX_TRACE_BYTES = 64 * 1024;

async function checkedDirectory(directory: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("Trace path must be a real directory");
  }
}

/** Writes redacted metadata to local workspace files; no external analytics client is involved. */
export class LocalTraceStore {
  readonly directory: string;

  constructor(workspaceRoot: string) {
    this.directory = path.join(path.resolve(workspaceRoot), ".thinktrim", "traces");
  }

  private async ready(create: boolean): Promise<void> {
    const parent = path.dirname(this.directory);
    await checkedDirectory(path.dirname(parent), false);
    await checkedDirectory(parent, create);
    await checkedDirectory(this.directory, create);
  }

  async record(input: LocalTraceInput): Promise<LocalTraceRecord> {
    const record = createLocalTraceRecord(input);
    const data = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(data) > MAX_TRACE_BYTES)
      throw new TypeError("Trace record exceeds size limit");
    await this.ready(true);
    const target = path.join(this.directory, `${record.traceId}.json`);
    const temporary = path.join(this.directory, `.${record.traceId}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(data, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return record;
  }

  async list(): Promise<readonly string[]> {
    try {
      await this.ready(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return (await readdir(this.directory)).filter((name) => TRACE_FILE.test(name)).sort();
  }
}
