import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

type DirectorySnapshot = readonly { path: string; metadata: Stats }[];

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Ancestor identity checks narrow path-swap races; they are not an OS-level sandbox. */
export async function captureDirectories(directory: string): Promise<DirectorySnapshot> {
  const paths: string[] = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    paths.unshift(current);
    if (path.dirname(current) === current) break;
  }
  const result: { path: string; metadata: Stats }[] = [];
  for (const entry of paths) {
    const metadata = await lstat(entry);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Refusing to use a non-regular configuration directory");
    }
    result.push({ path: entry, metadata });
  }
  return result;
}

export async function checkDirectories(snapshot: DirectorySnapshot): Promise<void> {
  for (const entry of snapshot) {
    const current = await lstat(entry.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(entry.metadata, current)
    ) {
      throw new Error("Directory changed during filesystem operation");
    }
  }
}

/** Read at most limit + 1 bytes, validating the opened object before returning any text. */
export async function readRegularFile(
  target: string,
  limit: number,
): Promise<{ text: string; mode: number } | null> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) {
    throw new RangeError("Invalid file size limit");
  }
  let directories: DirectorySnapshot;
  let before: Stats;
  try {
    directories = await captureDirectories(path.dirname(target));
    before = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("File must be regular");
  if (before.size > limit) throw new Error("File exceeds size limit");
  const flags = constants as unknown as Record<string, number>;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !sameVersion(before, opened))
      throw new Error("File changed before read");
    await checkDirectories(directories);
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    if (length > limit) throw new Error("File exceeds size limit");
    const after = await handle.stat();
    const current = await lstat(target);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      length !== opened.size ||
      !sameVersion(opened, after) ||
      !sameVersion(after, current)
    ) {
      throw new Error("File changed during read");
    }
    await checkDirectories(directories);
    return { text: bytes.subarray(0, length).toString("utf8"), mode: opened.mode & 0o777 };
  } catch (error) {
    // A disappearance after initial inspection is a conflict, not a missing config.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("File or directory changed during read", { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
