# Step 33 — targeted emergency gate

Date: 2026-09-26. Mode: AUDIT. Input: the attached Step 32 audit and the pending index-refresh issue in `IMPLEMENTATION_STATUS.md`. No separate failing-case packet or model-attributed Sol conclusion was supplied; the prior conclusions below come from those two documents. This step inspected the affected CLI filesystem operations, repository refresh, and installed Python dependency metadata. It did not repeat the repository-wide audit.

## EG-01 — unsafe CLI reads

**Prior conclusion:** Step 32 rejected static symlinks but left separate `lstat` and `readFile` operations vulnerable to replacement. Config reads were unbounded; trace reads could allocate beyond their cap if the file grew after inspection.

**Relevant files:** `packages/cli/src/{setup,index,safe-files}.ts` and `packages/cli/tests/file-races.test.ts`.

**Reproduction and failing tests:** deterministic filesystem hooks replace an ordinary config or trace after `lstat` returns its original metadata. Setup accepted replacement content; trace emitted it. A valid JSON config larger than 1 MiB was accepted. All three rejection tests failed before the fix.

**Fix:** a CLI-local reader captures ancestor identities, checks the inspected file against the opened handle, reads at most the cap plus one byte, and rechecks size, modification/change times, file identity, path type, and ancestor identities before returning text. Configuration has a 1 MiB cap; traces and index manifests have 64 KiB caps. Missing files are distinguished from disappearance after inspection. `O_NOFOLLOW` and `O_NONBLOCK` are used where available. Oversized or changed data is rejected before parsing or emission. Index-manifest errors propagate instead of being swallowed.

**Architecture constraint:** filesystem defenses stay in the Node CLI; no host APIs or filesystem helpers enter the decision core. Ancestor symlinks, including symlinked workspace roots, are refused conservatively.

## EG-02 — setup overwrote an intervening edit

**Prior conclusion:** atomic rename protects against partial writes, but the existing conflict check happened before writing the temporary file.

**Relevant files:** `packages/cli/src/setup.ts` and `packages/cli/tests/file-races.test.ts`.

**Reproduction and failing test:** a filesystem hook changes the target after the staged file is synced. Setup previously completed and overwrote that edit; the rejection test failed.

**Fix:** re-read and compare the target immediately before commit, validate staged content, and recheck captured directory identities before rename. Cap outgoing configuration size too. Cleanup refuses a replaced ancestor. Regression coverage also tampers with staged content and verifies the original configuration survives.

**Remaining boundary:** these checks are not a transactional compare-and-swap. Another process can still mutate a pathname after the last check. Fully eliminating this requires OS-specific handle-relative operations or an isolated checkout. A detected directory swap can leave a temporary file behind rather than risk deleting through the replacement directory. No full immunity to filesystem races is claimed.

## EG-03 — stale incremental index with preserved timestamps

**Prior conclusion:** the implementation status explicitly noted that equal size and modification time could hide source edits.

**Relevant files:** `packages/repo-indexer/src/index.ts`, its README, and `packages/repo-indexer/tests/index.test.ts`.

**Reproduction and failing test:** replace `before` with the equally long `afterx` function name, restore the original timestamp, and refresh. The old symbol remained before the fix; the test confirms both metadata attributes were equal.

**Fix:** perform the existing bounded read and compare SHA-256 before reusing parsed records. Changed bytes trigger parsing; unchanged content retains reuse with current metadata. Symbols, lexical terms, and dependency rebuilding use the refreshed records. The new test checks old-symbol removal, new-symbol discovery, changed hash, and reuse on a subsequent unchanged refresh.

**Architecture constraint:** keep deterministic in-memory indexing with bounded reads. Hashing costs I/O; parsing reuse remains. MCP still exposes a snapshot until an explicit refresh, and this change does not claim to add a filesystem watcher.

## Verification

- Before changes: 5 new regression tests failed, with 4 existing index tests passing.
- After changes: all 18 focused CLI/index tests passed, including the original five failures, ordinary ancestor replacement, staging tampering, exact byte boundaries, oversized index-manifest refusal, and existing host setup/uninstall contracts.
- `pnpm typecheck` passed, including workspace build and strict test compilation. Test types were checked again after the additional regression tests.
- `pnpm test` passed: 117 Vitest tests, 19 Node tests; one credential-gated Jev test skipped. Node coverage includes actual Python protocol startup/shutdown with no real model.
- `pnpm lint` passed after fixing its missing-error-cause finding.
- Existing index benchmark, source files plus one `.gitignore`: 25 files, initial/search-100/refresh 81/5/67 ms; 500 files, 1,143/32/1,233 ms; 5,000 files, 9,101/212/8,768 ms. Every unchanged record was reused. These are single-run observations, not a controlled performance comparison with Step 9.
- `uvx pip-audit --path .venv/Lib/site-packages --format json` from the sidecar directory: no known vulnerabilities in 12 installed third-party distributions; the local unpublished sidecar distribution was skipped. Auditor version: 2.10.1. Raw output: `docs/security/step33-python-audit.json`. The optional Laya/model dependencies are not installed and were not scanned. No Python dependencies or model weights were installed into the project by this check.
- Follow-up optional-model scan: exported the frozen lockfile with `uv export --frozen --extra model --no-dev --no-emit-project --no-hashes`, then ran `uvx pip-audit --requirement <export> --no-deps --disable-pip --format json`. No known vulnerabilities in all 36 selected packages, including Laya 0.3.20, Torch 2.14.0, and Transformers 5.17.0; none skipped. Raw output: `docs/security/step33-model-audit.json`. This checks package/version advisories under the auditor's Windows environment markers, not other platform variants or the safety of model checkpoints. No optional packages or weights were installed into the project.

## Disposition of the attached audit's other open risks

- **Exposed OpenRouter credential:** still requires provider-side revocation/rotation and replacement of the local secret. This run did not read, print, test, revoke, or replace the key. Git-ignore cannot revoke a credential or remove its conversation exposure. OneDrive secret storage remains an operational concern.
- **Semantic prompt injection:** remains a host trust boundary. Repository metadata and tool results are advisory, untrusted data. No claim that escaping can prevent an agent from following malicious prose; existing deterministic side-effect and egress guards remain required.
- **Novel secret names and inaccurate data labels:** simple patterns cannot prove content non-sensitive. Local-only behavior and explicit, accurate host egress classification remain necessary. A generic secret detector or fabricated consent was not introduced.
- **Installed-host testing:** earlier Codex evidence and the Claude Desktop/Cursor/VS Code gaps remain as documented in `COMPATIBILITY.md`. No new live desktop verification was performed; this session does not expose native desktop automation. The earlier Codex worker-lifecycle issue was not reproduced or declared fixed.
- **Real Laya model / optional dependencies:** model loading, quality, and hardware behavior remain unverified. Both the installed Python development/protocol environment and Windows-selected locked optional-model packages now have advisory scans; other platform variants remain outside this run.
- **Calibration:** Step 31 still lacks independent scoped fitting and held-out evidence. Provisional thresholds remain provisional.

The reproducible code repairs above are complete. The overall security/release gate remains open for the external verification and credential items; this document does not certify all hosts or eliminate the residual threat boundaries.
