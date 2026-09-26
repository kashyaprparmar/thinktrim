# Codex integration

Run `thinktrim setup codex --dry-run` from a project root to preview the `.codex/config.toml` update, then `thinktrim setup codex` to apply it. The command parses and merges TOML, adds `[mcp_servers.thinktrim]`, preserves other settings, refuses a conflicting ThinkTrim entry, and writes atomically. `thinktrim uninstall codex` removes only that exact managed entry. Existing TOML comments and formatting may change when a file is rewritten.

The stdio entry launches the built Node CLI with `mcp --workspace <absolute project path>` and sets `cwd` to that project. Codex loads project `.codex/config.toml` only after the project is trusted. The ChatGPT desktop app, Codex CLI, and IDE extension share MCP configuration; use `codex mcp list` or `/mcp` to inspect the connection after restarting the host if needed.

The exposed ThinkTrim workflow covers indexed context retrieval, deterministic file ranking, conservative sufficiency checks, and bounded failure classification. Codex chooses when to call those tools. The integration has no access to hidden Codex reasoning or private context. Plugins, skills, hooks, and `AGENTS.md` are supported Codex extension points, but setup leaves them untouched because MCP supplies the V1 tools without extra permanent instructions.

References: [OpenAI Docs: Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
