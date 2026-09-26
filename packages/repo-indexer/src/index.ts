/** Deterministic, in-memory repository discovery and lexical retrieval. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { extractImports, extractSymbols, languageFor, resolveImport } from "./extract.js";
import type { ImportRecord, SymbolRecord } from "./extract.js";

export type { ImportRecord, SymbolRecord, SymbolKind } from "./extract.js";
export interface FileMetadata {
  readonly path: string;
  readonly language: string | null;
  readonly extension: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}
export interface FileRecord extends FileMetadata {
  readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly ImportRecord[];
}
export interface SearchHit<T> {
  readonly item: T;
  readonly score: number;
  readonly matchedTerms?: readonly string[];
}
export interface IndexStats {
  readonly discovered: number;
  readonly indexed: number;
  readonly reused: number;
  readonly removed: number;
  readonly skipped: number;
  readonly durationMs: number;
}
export interface IndexOptions {
  /** Maximum bytes read from a single file. Defaults to 1 MiB. */
  readonly maxFileBytes?: number;
  /** Maximum files admitted to the index. Defaults to 100,000. */
  readonly maxFiles?: number;
  readonly signal?: AbortSignal;
}
export interface SearchOptions {
  readonly limit?: number;
}
interface IndexedFile {
  readonly metadata: FileMetadata;
  readonly symbols: readonly SymbolRecord[];
  readonly imports: readonly Omit<ImportRecord, "resolvedPath">[];
  readonly terms: ReadonlyMap<string, number>;
  readonly length: number;
}
interface IgnoreScope {
  readonly prefix: string;
  readonly matcher: Ignore;
}

const excludedDirs = new Set([
  ".git",
  ".thinktrim",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "out",
  ".output",
  "generated",
  "gen",
  ".aws",
  ".ssh",
  ".gnupg",
]);
const excludedFiles = /(?:\.min\.(?:js|css)|\.generated\.[^.]+|\.g\.[^.]+|\.map)$/i;
const sensitiveFiles =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;

function relativePath(value: string): string {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    throw new RangeError("Expected a workspace-relative file path");
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new RangeError("File path escapes the workspace");
  }
  return normalized;
}

function tokenize(input: string): string[] {
  return (
    input
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((term) => term.length > 1 || /\d/.test(term));
}
function countTerms(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(input)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}
function isBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  let controls = 0;
  for (const byte of sample)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) controls++;
  return sample.length > 0 && controls / sample.length > 0.05;
}
async function readBoundedRegularFile(absolute: string, maxBytes: number): Promise<Buffer | null> {
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const handle = await open(absolute, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(opened.size + 1, 4096)));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length > maxBytes ||
      after.size !== length ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      return null;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function loadIgnore(directory: string, prefix: string): Promise<IgnoreScope | null> {
  const target = path.join(directory, ".gitignore");
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    if (metadata.size > 64 * 1024) throw new RangeError(".gitignore exceeds 64 KiB");
    const bytes = await readBoundedRegularFile(target, 64 * 1024);
    if (!bytes) throw new RangeError(".gitignore changed or exceeds 64 KiB");
    return {
      prefix,
      matcher: ignore().add(bytes.toString("utf8")),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function isIgnored(relative: string, directory: boolean, scopes: readonly IgnoreScope[]): boolean {
  let result = false;
  for (const scope of scopes) {
    if (scope.prefix && !relative.startsWith(`${scope.prefix}/`)) continue;
    const scoped = scope.prefix ? relative.slice(scope.prefix.length + 1) : relative;
    const test = scope.matcher.test(directory ? `${scoped}/` : scoped);
    if (test.ignored) result = true;
    else if (test.unignored) result = false;
  }
  return result;
}
function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return limit;
}
function searchLimit(value: number | undefined): number {
  const limit = positiveLimit(value, 40, "limit");
  if (limit > 10_000) throw new RangeError("limit must be at most 10,000");
  return limit;
}

/** In-memory snapshot. Refresh reuses parsed records only after verifying their content hash. */
export class RepositoryIndex {
  readonly root: string;
  readonly stats: IndexStats;
  readonly files: ReadonlyMap<string, FileRecord>;
  private readonly raw: ReadonlyMap<string, IndexedFile>;
  private readonly postings: ReadonlyMap<string, ReadonlyMap<string, number>>;
  private readonly averageLength: number;
  private readonly dependents: ReadonlyMap<string, readonly string[]>;
  private readonly options: IndexOptions;

  constructor(
    root: string,
    raw: Map<string, IndexedFile>,
    stats: IndexStats,
    options: IndexOptions,
  ) {
    this.root = root;
    this.raw = raw;
    this.stats = stats;
    this.options = {
      maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
      maxFiles: options.maxFiles ?? 100_000,
    };
    const files = new Map<string, FileRecord>();
    const dependents = new Map<string, Set<string>>();
    const postings = new Map<string, Map<string, number>>();
    const paths = new Set(raw.keys());
    let totalLength = 0;
    for (const [filePath, record] of raw) {
      const imports: ImportRecord[] = record.imports.map((item) => ({
        ...item,
        resolvedPath: resolveImport(filePath, item.specifier, paths),
      }));
      files.set(filePath, { ...record.metadata, symbols: record.symbols, imports });
      for (const item of imports)
        if (item.resolvedPath) {
          const set = dependents.get(item.resolvedPath) ?? new Set<string>();
          set.add(filePath);
          dependents.set(item.resolvedPath, set);
        }
      totalLength += record.length;
      for (const [term, frequency] of record.terms) {
        const posting = postings.get(term) ?? new Map<string, number>();
        posting.set(filePath, frequency);
        postings.set(term, posting);
      }
    }
    this.files = files;
    this.postings = postings;
    this.averageLength = raw.size ? totalLength / raw.size : 1;
    this.dependents = new Map([...dependents].map(([key, value]) => [key, [...value].sort()]));
  }

  getFile(filePath: string): FileRecord | undefined {
    return this.files.get(relativePath(filePath));
  }
  getDependencies(filePath: string): readonly string[] {
    return [
      ...new Set(
        this.getFile(filePath)?.imports.flatMap((item) =>
          item.resolvedPath ? [item.resolvedPath] : [],
        ) ?? [],
      ),
    ].sort();
  }
  getDependents(filePath: string): readonly string[] {
    return this.dependents.get(relativePath(filePath)) ?? [];
  }

  searchFiles(query: string, options: SearchOptions = {}): SearchHit<FileRecord>[] {
    const limit = searchLimit(options.limit);
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const scores = new Map<string, number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (this.files.size - posting.size + 0.5) / (posting.size + 0.5));
      for (const [filePath, frequency] of posting) {
        const length = this.raw.get(filePath)?.length ?? 1;
        const score =
          (idf * frequency * 2.2) /
          (frequency + 1.2 * (0.25 + (0.75 * length) / this.averageLength));
        scores.set(filePath, (scores.get(filePath) ?? 0) + score);
      }
    }
    return [...scores]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([filePath, score]) => ({
        item: this.files.get(filePath)!,
        score,
        matchedTerms: terms.filter((term) => this.postings.get(term)?.has(filePath)),
      }));
  }

  searchSymbols(query: string, options: SearchOptions = {}): SearchHit<SymbolRecord>[] {
    const limit = searchLimit(options.limit);
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const hits: SearchHit<SymbolRecord>[] = [];
    for (const file of this.files.values())
      for (const symbol of file.symbols) {
        const words = tokenize(`${symbol.name} ${symbol.filePath}`);
        const matched = terms.filter((term) => words.includes(term)).length;
        if (matched)
          hits.push({
            item: symbol,
            score:
              matched / terms.length + (symbol.name.toLowerCase() === query.toLowerCase() ? 1 : 0),
          });
      }
    return hits
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
      .slice(0, limit);
  }

  refresh(options: IndexOptions = {}): Promise<RepositoryIndex> {
    return buildIndex(this.root, { ...this.options, ...options }, this);
  }
  /** Internal immutable input for incremental reuse. */
  previousRecord(filePath: string): IndexedFile | undefined {
    return this.raw.get(filePath);
  }
}

async function buildIndex(
  root: string,
  options: IndexOptions,
  previous?: RepositoryIndex,
): Promise<RepositoryIndex> {
  const started = performance.now();
  const maxFileBytes = positiveLimit(options.maxFileBytes, 1024 * 1024, "maxFileBytes");
  if (maxFileBytes > 8 * 1024 * 1024) {
    throw new RangeError("maxFileBytes must be at most 8 MiB");
  }
  const maxFiles = positiveLimit(options.maxFiles, 100_000, "maxFiles");
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new TypeError("Workspace root must be a directory");
  if (previous && previous.root !== canonicalRoot)
    throw new RangeError("Previous index belongs to another workspace");
  const raw = new Map<string, IndexedFile>();
  let discovered = 0,
    indexed = 0,
    reused = 0,
    skipped = 0;

  function insideRoot(resolved: string): boolean {
    const relative = path.relative(canonicalRoot, resolved);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }

  async function walk(
    directory: string,
    prefix: string,
    parentScopes: readonly IgnoreScope[],
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const local = await loadIgnore(directory, prefix);
    const scopes = local ? [...parentScopes, local] : parentScopes;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name) || isIgnored(relative, true, scopes)) {
          skipped++;
          continue;
        }
        const child = path.join(directory, entry.name);
        if (!(await lstat(child)).isDirectory() || !insideRoot(await realpath(child))) {
          skipped++;
          continue;
        }
        await walk(child, relative, scopes);
        continue;
      }
      if (
        !entry.isFile() ||
        excludedFiles.test(entry.name) ||
        sensitiveFiles.test(entry.name) ||
        isIgnored(relative, false, scopes)
      ) {
        skipped++;
        continue;
      }
      discovered++;
      const absolute = path.join(directory, entry.name);
      try {
        const metadata = await lstat(absolute);
        if (!metadata.isFile() || !insideRoot(await realpath(absolute))) {
          skipped++;
          continue;
        }
        if (metadata.size > maxFileBytes) {
          skipped++;
          continue;
        }
        if (raw.size >= maxFiles) throw new RangeError(`Index file limit exceeded (${maxFiles})`);
        const old = previous?.previousRecord(relative);
        const bytes = await readBoundedRegularFile(absolute, maxFileBytes);
        if (!bytes || !insideRoot(await realpath(absolute)) || isBinary(bytes)) {
          skipped++;
          continue;
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (old?.metadata.sha256 === sha256) {
          raw.set(relative, { ...old, metadata: { ...old.metadata, mtimeMs: metadata.mtimeMs } });
          reused++;
          continue;
        }
        const contents = bytes.toString("utf8");
        const language = languageFor(relative, contents);
        const fileMetadata: FileMetadata = {
          path: relative,
          language,
          extension: path.posix.extname(relative).toLowerCase(),
          size: bytes.length,
          mtimeMs: metadata.mtimeMs,
          sha256,
        };
        const symbols = extractSymbols(relative, language, contents);
        const imports = extractImports(language, contents);
        const terms = countTerms(
          `${relative} ${relative} ${symbols.map((symbol) => symbol.name).join(" ")} ${contents}`,
        );
        raw.set(relative, {
          metadata: fileMetadata,
          symbols,
          imports,
          terms,
          length: [...terms.values()].reduce((a, b) => a + b, 0),
        });
        indexed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          skipped++;
          continue;
        }
        throw error;
      }
    }
  }
  await walk(canonicalRoot, "", []);
  const removed = previous
    ? [...previous.files.keys()].filter((filePath) => !raw.has(filePath)).length
    : 0;
  return new RepositoryIndex(
    canonicalRoot,
    raw,
    {
      discovered,
      indexed,
      reused,
      removed,
      skipped,
      durationMs: performance.now() - started,
    },
    options,
  );
}

export function indexWorkspace(root: string, options: IndexOptions = {}): Promise<RepositoryIndex> {
  return buildIndex(root, options);
}
export function searchFiles(
  index: RepositoryIndex,
  query: string,
  options?: SearchOptions,
): SearchHit<FileRecord>[] {
  return index.searchFiles(query, options);
}
export function searchSymbols(
  index: RepositoryIndex,
  query: string,
  options?: SearchOptions,
): SearchHit<SymbolRecord>[] {
  return index.searchSymbols(query, options);
}
export function getDependencies(index: RepositoryIndex, filePath: string): readonly string[] {
  return index.getDependencies(filePath);
}
export function getDependents(index: RepositoryIndex, filePath: string): readonly string[] {
  return index.getDependents(filePath);
}
