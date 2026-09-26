# Repository indexer

`@thinktrim/repo-indexer` discovers local text files and provides deterministic retrieval. It does not call a decision backend or retain full source text after indexing.

```ts
import { indexWorkspace } from "@thinktrim/repo-indexer";

let index = await indexWorkspace(workspaceRoot);
const files = index.searchFiles("request validation", { limit: 30 });
const symbols = index.searchSymbols("validateRequest");
const imports = index.getDependencies("src/app.ts");
const callers = index.getDependents("src/validation.ts");
index = await index.refresh();
```

`indexWorkspace()` reads root and nested `.gitignore` files, skips symlinks, binary and oversized files, and excludes common dependency, build, cache, and generated directories. It records path, extension, language, size, modification time, SHA-256, symbols, imports, and BM25 token counts. Search results include a lexical score and stable path or symbol ID. Local import edges are resolved for relative JavaScript/TypeScript paths (including `.js` specifiers pointing at TypeScript sources) and common Python module paths. Unresolved imports retain their specifier with `resolvedPath: null`.

Defaults are 1 MiB per file, 100,000 indexed files, and 40 search hits. `AbortSignal` is checked during traversal. Refresh reads and hashes eligible files before reusing parsed records with identical content, then rebuilds postings and dependency edges. Edits are detected even if size and modification time are preserved. Reuse saves parsing work but still requires file reads. The index is in memory; no persistent source cache or vector database is used.

Symbol and import extraction is deliberately lightweight, line-based, and best effort. It is not a language parser: multiline syntax, aliases, workspace package resolution, and some dynamic imports are not fully modeled. `getDependencies()` and `getDependents()` return resolved local file edges only.

Run `pnpm --filter @thinktrim/repo-indexer benchmark` for generated 25, 500, and 5,000 source-file fixtures. The harness reports initial indexing, 100 lexical searches, and unchanged refresh in milliseconds. The fixture also contains one `.gitignore` file, which is indexed.
