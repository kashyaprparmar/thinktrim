# Claude Code integration

From the project root, run `thinktrim setup claude --dry-run` to preview the project-scoped `.mcp.json` update, then `thinktrim setup claude` to apply it. ThinkTrim merges only the `thinktrim` entry under `mcpServers`, refuses a conflicting entry, and writes the result atomically. `thinktrim uninstall claude` removes that exact managed entry.

The configured stdio command launches `thinktrim mcp --workspace ${CLAUDE_PROJECT_DIR:-.}`. Claude Code sets `CLAUDE_PROJECT_DIR` for local servers, and its project configuration supports this environment expansion in arguments. This keeps repository retrieval scoped to the Claude project root even if the server process starts elsewhere. Claude Code requests approval for project servers; inspect its connection with `claude mcp get thinktrim` or `/mcp`.

The MCP tools already describe when to retrieve and rank context. Setup does not add `CLAUDE.md`, hooks, commands, or skills, so there is no extra always-loaded instruction text or automatic hook overhead. A host must choose to call the tools; setup does not intercept private reasoning.

References: [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp), [Claude Code project files](https://code.claude.com/docs/en/claude-directory).
