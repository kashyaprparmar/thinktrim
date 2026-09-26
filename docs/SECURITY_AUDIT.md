# ThinkTrim security audit — Step 32

Date: 2026-09-25. Mode: AUDIT. Scope: the current V1 source and generated host configuration for MCP, CLI, Claude Code, Codex, Cursor, VS Code, Jev, Laya HTTP/local, the Python sidecar, repository indexer, cache, telemetry, retry policy, hooks, filesystem reads, and configuration writes.

## Method and boundary

This was a source review of trust boundaries, targeted adversarial tests, a local npm advisory scan, and the existing integration suite. It was not a penetration test of installed Claude/Codex/Cursor clients or a real Laya model. The remote Jev test remained credential-gated; no repository data was sent during this audit. The four project host config files currently contain empty MCP server maps after Step 28 uninstall. There are no ThinkTrim hooks, rules, or shell execution tools in the project integrations.

Repository files, file names, symbols, `.gitignore`, terminal logs, MCP arguments, provider responses, host config files, and traces are treated as untrusted. The MCP server exposes advisory indexing, ranking, gating, and classification over stdio with bounded Zod schemas. It exposes no arbitrary filesystem read or shell command tool. JSON output still carries repository-controlled names, so host agents must treat those fields as data.

## Fixed findings

### SA-01 — Config-directory symlink could redirect host setup (high)

`prepareHostPlans()` checked the target file but previously followed a symlinked `.cursor`, `.codex`, `.vscode`, or `.thinktrim` parent. In a malicious workspace, `setup` or `init` could write through that link outside the intended checkout. `readExisting()` and `applyPlan()` now reject a symlinked or non-directory config parent before reading or writing. A Windows junction regression test confirms Cursor setup refuses the redirected directory and leaves the outside file unchanged. Atomic same-directory replace and conflict checks remain in place. A concurrent directory replacement between checks and rename is still a filesystem race; see residual risks.

### SA-02 — CLI trace lookup could follow a symlink (medium)

`thinktrim trace --id` validated the ID but could follow a symlinked `.thinktrim/traces` directory or trace file. It now checks both trace directories and the selected file with `lstat`, rejects symlinks and non-regular files, and checks the file size before reading. A junction test exercises the directory boundary. File-link creation is restricted by this Windows host, so a file-symlink race was not exercised here.

### SA-03 — Indexer admitted common credential files (high)

Without a `.gitignore` rule, `.env.local` and private-key files entered the lexical index. They could influence retrieval and expose sensitive names/terms to downstream context preparation. The indexer now hard-excludes `.env*`, common credential and key file names/extensions, and `.aws`, `.ssh`, and `.gnupg` directories. The regression fixture verifies `.env.local` and a PEM file are absent even without ignore rules. This pattern list is a guard, not a complete secret detector.

### SA-04 — Indexer could read a symlinked or oversized `.gitignore` (medium)

The indexer previously called `readFile()` on `.gitignore` without a regular-file check or byte limit. It now rejects symlinked/non-regular ignore files, caps them at 64 KiB, and reads regular source files through a bounded file handle with pre-open and post-read identity/size checks. The regular source-file limit is capped at 8 MiB even if a caller supplies a larger option. The existing directory-junction test and new sensitive-file assertions pass. On this Windows runtime `O_NOFOLLOW` is unavailable, so inode/size checks narrow but cannot eliminate all concurrent path-swap races.

### SA-05 — Python sidecar import could resolve a workspace package (high)

The default `python -m thinktrim_laya_sidecar` invocation inherited a workspace current directory. A repository package with the same name could run instead of the installed sidecar. The default now invokes Python with `-I` and starts in the directory containing the Node executable. A real Node-to-Python test placed a hostile same-named package in the worker directory and confirmed it was not executed. Explicit custom commands, arguments, working directories, and installed Python packages remain caller-controlled trust decisions.

### SA-06 — Jev could trust incomplete remote data labels (medium)

The Jev adapter checked caller-supplied `dataClasses`, but a caller could omit `paths`/`summaries` while still supplying candidates or evidence. It now derives minimum permission from those populated fields: candidate data requires `paths` or `summaries` permission, and evidence requires `summaries` permission. Mock HTTP tests confirm these requests fail before `fetch`. A caller can still mislabel actual snippets embedded in free-form task/labels; host composition must classify content honestly and obtain explicit egress consent.

### SA-07 — Keyed write retry lacked proof of the previous key (high)

For `idempotency_key`, an attempt-1 write with a proposed key but no record of the failed attempt's key could receive an automatic retry recommendation. `RetryPolicy` now requires `previousResult.idempotencyKey` and an exact match for every keyed retry. Tests cover missing, changed, and matching keys. The policy only recommends retries; it does not execute them. Hosts still must supply truthful operation type, side-effect risk, and previous-result metadata.

### SA-08 — Repository path could inject VS Code log or Markdown structure (medium)

The extension printed ranked paths directly into the output channel and local Markdown trace. A filename containing newline, terminal control characters, or Markdown link syntax could spoof log lines or create a clickable command link. Paths are now JSON-escaped for logs and Markdown-escaped with control characters replaced in trace/doctor output. A test covers newline, ANSI escape, and a command-style Markdown link. Tool users may still see attacker-chosen path words as ordinary data.

### SA-09 — Vulnerable Vitest development dependency (moderate)

`pnpm audit` found the Vitest/@vitest/mocker path-traversal file-read advisory [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) in the installed 3.2.7 test dependency. The project now uses patched Vitest 4.1.11 with an updated lockfile. `pnpm audit` reports no known npm vulnerabilities after the upgrade. The advisory concerns development-server exposure; this audit did not find a ThinkTrim runtime dependency on the vulnerable mocker.

## Controls checked without a code change

- **MCP and prompt injection:** tool arguments have bounded strict schemas; output is JSON with no shell execution capability. Indexing returns paths, symbols, imports, and matched terms rather than initial full-file contents. Repository-controlled strings remain untrusted when shown to an agent. A host must not execute instructions found in them.
- **Provider transport and secrets:** Jev uses a fixed HTTPS OpenRouter endpoint, a bearer token supplied through the process/host secret store, bounded responses, no redirect following, and status/code-only errors. Laya HTTP is restricted to loopback endpoints. The Python worker uses inherited pipes, bounded JSONL frames, and drains stderr without surfacing model text. No provider response body or API key is placed in a ThinkTrim trace.
- **Filesystem and config:** indexing checks canonical root containment and skips symlink entries; setup parses JSON/TOML, protects an existing owned key, and writes through a temporary file and atomic rename. Host setup does not execute repository scripts. Codex TOML serialization can still discard comments/formatting.
- **Cache and telemetry:** the decision cache is in memory, requires a repository-state fingerprint, and keys on workspace, backend/model, policy, and request semantics. Its correctness depends on a host supplying a fresh state fingerprint. Local telemetry uses a fixed allowlist and omits task text, source, paths, request IDs, provider error bodies, and secrets; there is no telemetry exporter. The local trace directory is Git-ignored and checked for symlinks by the writer.
- **Hooks and retries:** no ThinkTrim hook or command interception is installed. Deterministic retry guards reject destructive, high-risk, unknown, and non-idempotent operations before optional inference. Full CI is never disabled by ThinkTrim test selection.

## Open risks and follow-up

Step 33 follow-up: `docs/EMERGENCY_GATE.md` records five reproduced failures and their fixes. CLI config/trace/manifest reads now use bounded handles and identity checks; setup rechecks target and staging content before rename. The installed Python environment and Windows-selected locked optional-model packages were scanned with no known third-party vulnerabilities. The numbered items below describe the original audit boundary; the Step 33 report provides their current disposition. Residual path races and the external credential/host checks remain open.

1. **Credential rotation is required if the earlier OpenRouter key is active.** A key was pasted into this project conversation during Step 7. This audit did not repeat it. `.env.local` exists and is Git-ignored; a scan of other workspace files found no matching long OpenRouter key. Conversation exposure cannot be undone by a source change. Revoke/rotate the key at the provider and replace the local value. Because the workspace is under OneDrive, review its sync and access policy for local secret files.
2. **Concurrent filesystem mutation remains a race.** Checks before `open`, `readFile`, or `rename` can be invalidated by another process. The indexer now uses a bounded file handle and identity checks; config and trace paths still rely on `lstat` around separate operations. Stronger guarantees require platform-specific handle-relative APIs or an isolated immutable checkout.
3. **Prompt injection remains a host-consumption risk.** Paths, symbol names, imports, evidence summaries, and terminal output can contain attacker-authored text. JSON escaping and display escaping prevent structural/log injection but cannot make an agent ignore semantic instructions. Hosts must keep ThinkTrim results advisory and source content lower-trust than user instructions.
4. **Sensitive-file patterns and remote labels are incomplete by nature.** A novel credential filename or a snippet mislabeled as a summary can bypass simple metadata guards. Remote use requires a host privacy review and explicit data-class permission. The VS Code extension currently uses Jev only for a synthetic connection check.
5. **Full installed-host behavior is not verified here.** The Step 28 compatibility report records the gaps for Claude Desktop, Cursor, and VS Code live activation. This audit did not load a real Laya model or scan Python dependency advisories. The npm advisory result is a snapshot on 2026-09-25.

## Verification

- `pnpm install --frozen-lockfile` — passed after the Vitest upgrade.
- `pnpm audit` — no known npm vulnerabilities after remediation.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` — passed. The final suite includes 108 Vitest tests and 19 Node tests; one credential-gated Jev Vitest test was skipped.
- `uv run --frozen ruff check src tests`, `uv run --frozen mypy src`, and `uv run --frozen pytest` — passed for the Python sidecar; pytest had seven passes and one gated real-model skip.
- Focused symlink, secret-exclusion, Jev egress, keyed retry, display escaping, and hostile Python import tests passed. The file-symlink case could not be created on this Windows host because the OS returned `EPERM`; directory junctions were exercised.

The related architecture threat model is in `docs/SECURITY_MODEL.md`; host test limitations are in `docs/COMPATIBILITY.md`.
