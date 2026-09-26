# Cursor integration

Run `thinktrim setup cursor --dry-run` to preview the project `.cursor/mcp.json` change, then `thinktrim setup cursor` to add the stdio server. The entry launches the built ThinkTrim CLI and passes `${workspaceFolder}` as its workspace. Cursor resolves that variable to the folder containing `.cursor/mcp.json`. The setup command preserves other MCP servers, refuses to overwrite a different `thinktrim` entry, and supports `thinktrim uninstall cursor`.

Open the project in Cursor and check the ThinkTrim server in Cursor's MCP settings. Cursor Agent can then call `thinktrim_context`, `thinktrim_rank`, `thinktrim_gate`, and `thinktrim_classify`. Project and global MCP configurations are merged by Cursor, with the project entry taking precedence on a name collision. Cursor CLI also discovers project MCP configuration. [Cursor MCP documentation](https://prod.cursor.com/docs/mcp), [Cursor CLI MCP documentation](https://prod.cursor.com/docs/cli/mcp).

The setup command does not install `.cursor/rules`, `AGENTS.md`, or an extension. MCP tool descriptions provide the small amount of guidance needed for V1; a rule can be added later if actual use shows a need.

## VS Code extension compatibility and distribution

ThinkTrim's `apps/vscode-extension` is currently a TypeScript shell, not an installable VSIX. The MCP setup above works without an extension.

When a VSIX is built, Cursor's extension panel may offer it through the Open VSX registry and Cursor's reviewed marketplace proxy. [Cursor's extension documentation](https://prod.cursor.com/help/customization/extensions) says many VS Code extensions are available, but it does not guarantee compatibility or listing. Publishing only to Microsoft's VS Code Marketplace does not establish Cursor availability. Cursor's [Plugin Marketplace](https://prod.cursor.com/docs/plugins) is a separate distribution channel for agent plugins; this integration does not publish one.

A local VSIX can also be installed manually through Cursor's Extensions panel. This path is described in a [Cursor forum release discussion](https://forum.cursor.com/t/extension-marketplace-changes-transition-to-openvsx/109138); confirm the installation flow against the target Cursor version when a VSIX exists.
