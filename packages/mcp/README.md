# ThinkTrim MCP server

Run `thinktrim mcp` to start the stdio server for Claude Code, Codex, Cursor, or VS Code. It uses the current MCP TypeScript SDK v2 and indexes the process working directory on demand.

The primary tools are:

- `thinktrim_context` — retrieve compact file candidates for a task.
- `thinktrim_rank` — rank those candidates with deterministic signals. Relevance is not calibrated confidence. If you start the server with `--decision-backend jev --allow-remote-data task,paths,summaries` and set `OPENROUTER_API_KEY`, the top 16 candidates' metadata is also sent to Jev. The returned scores are uncalibrated advisories in `decisionBackend.advisory`; the deterministic order is unchanged. See the CLI README for the full egress and fallback contract.
- `thinktrim_gate` — check whether supplied evidence is sufficient. Without a configured calibrated decision engine, complete evidence remains `uncertain`; missing evidence is `insufficient`.
- `thinktrim_classify` — normalize and classify bounded terminal failure output.

The existing status, index refresh, file search, symbol search, and dependency lookup tools remain available. All tool arguments have bounded schemas, and the server exposes no shell execution.

Search results contain relative paths and compact symbol/import metadata. The MCP tools do not return source file contents. Index data is held in process memory and honors the repository indexer's ignore, binary, and size rules. No server messages are written to stdout outside the MCP protocol.
