# ThinkTrim CLI

After publication, install the bundled CLI globally from npm:

```sh
npm install --global thinktrim
```

Or with pnpm:

```sh
pnpm add --global thinktrim
```

The `thinktrim` executable is a project-aware CLI for initialization, workspace indexing, diagnostics, local traces, deterministic benchmarks, MCP stdio serving, and host configuration. Node.js 20 or later is required. Runtime dependencies are bundled into the executable package.

For Codex, run these commands from the project you want to connect:

```sh
thinktrim doctor
thinktrim setup codex --dry-run
thinktrim setup codex
```

Trust and reopen the project in Codex to load its project-scoped MCP configuration. Verify the server with `codex mcp list`.

```sh
thinktrim status
thinktrim index
thinktrim mcp
thinktrim trace
thinktrim benchmark
```

`thinktrim setup claude|codex|cursor|vscode|all` adds the local MCP server to each host's project or user config. Setup and uninstall accept `--dry-run`. The commands parse and validate existing JSON or TOML, merge the `thinktrim` server entry, reject a conflicting customized entry, and write through a same-directory temporary file and atomic rename. `setup all` reads and validates every target before writing any target.

All host setup commands are project-scoped. Codex uses the trusted project's `.codex/config.toml`; its entry supplies an explicit project root and working directory. The configuration launches the built CLI entry with `node .../cli.js mcp`. Claude supplies its project root through `CLAUDE_PROJECT_DIR`; Cursor resolves `${workspaceFolder}` from project MCP config. VS Code currently uses the server process working directory as the workspace root.

Configuration reads and writes are capped at 1 MiB; trace and index-manifest reads are capped at 64 KiB. Reads use bounded file handles and verify file and ancestor-directory identities before returning text. Setup rechecks the target and staged content before atomic replacement. Symlinked ancestors are refused, including symlinked workspace roots. These checks detect tested concurrent replacements but cannot provide a cross-platform atomic compare-and-replace guarantee against a process actively mutating the same directories. Use an isolated checkout for hostile repositories; a detected directory replacement can leave the temporary file behind rather than attempt cleanup through an untrusted path.

## Optional Jev advisory scoring (remote, opt-in)

By default, `thinktrim mcp` is deterministic and sends nothing off the machine. From this release, `thinktrim_rank` can also request scores from TypeSafe Jev (`typesafe/jev-1.13`) through OpenRouter's Decisions API. This requires both of these:

```sh
thinktrim mcp --decision-backend jev --allow-remote-data task,paths,summaries
```

- `--allow-remote-data` is your explicit data-egress consent. Ranking requests contain the task text, candidate paths, language, symbol/import names, matched terms, and content hashes. Source file bodies are never sent. If the list omits any of `task`, `paths`, or `summaries`, the server sends nothing.
- The API key is read only from `OPENROUTER_API_KEY` in the server's environment. The server has no command-line option for the key, so it cannot end up in host config files or process listings. Keep the key in your OS or shell secret store rather than in the repository.
- Only the top 16 deterministic candidates are sent, in one request per `thinktrim_rank` call. Jev never scores the retrieval, context, gate, or classify tools.
- **Scores are uncalibrated.** ThinkTrim ships no Jev calibrator, so Jev cannot reorder `ranked`. The Jev scores appear separately under `decisionBackend.advisory` as a hint. `decisionBackend` also reports `state`, `reasonCode`, `remoteRequestsAttempted`, latency, and token usage. `advisory.backend` confirms that a live call succeeded.
- On a missing key, missing consent, timeout, or provider error, the result falls back to deterministic ranking and reports the reason. `thinktrim_status` shows the configuration, and the server writes a one-line notice to stderr (the host's MCP log) at startup.
- Jev is a structured decision model. It does not replace the host's coding model and cannot see the host's hidden reasoning.

Setup does not add these options. To enable them, edit the host's ThinkTrim entry by hand and forward the key:

- Codex `.codex/config.toml`: append the four arguments to `args` and add `env_vars = ["OPENROUTER_API_KEY"]`.
- Claude Code `.mcp.json`: append the arguments and add `"env": { "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}" }`.
- Cursor `.cursor/mcp.json`: append the arguments and add `"env": { "OPENROUTER_API_KEY": "${env:OPENROUTER_API_KEY}" }`.

Once edited, `thinktrim uninstall` treats the entry as customized and leaves it alone. Remove it by hand when you no longer want it.

`index` stores only a small run manifest under `.thinktrim/last-index.json`; the file index itself remains in memory. `trace` reads redacted JSON files written by `@thinktrim/telemetry` under `.thinktrim/traces/`; hosts must call that package to emit traces. `benchmark` reports a local index/search baseline and makes no model-quality or token-savings claim.

Codex configuration is parsed and semantically merged as TOML; serialization may reformat the file and remove comments. Host configuration plans have been smoke-checked with `--dry-run`; validate the resulting setup with each installed host before relying on it in a workflow.
