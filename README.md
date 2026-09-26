# ThinkTrim

> Trim the tiny decisions. Save the big model for the hard stuff.

ThinkTrim is an open-source decision coprocessor for AI coding agents. It uses deterministic retrieval first, then bounded local or hosted inference where measured results justify it. It is designed for Claude Code, OpenAI Codex, Cursor, and VS Code; the first three work through MCP without the VS Code extension.

The repository contains the shared/core decision engine, provider adapters, repository indexer, ranking and decision policies, an MCP server, the universal `thinktrim` CLI, and a VS Code extension with context commands and a metrics sidebar. Product architecture and security decisions are documented in [`docs/`](docs/PROJECT_CONTEXT.md).

## Workspace

- `packages/` — TypeScript packages for core contracts, providers, repository indexing, ranking, policies, MCP, CLI, telemetry, shared types, and host composition.
- `apps/vscode-extension/` — VS Code commands, configuration, SecretStorage, backend checks, and measured/estimated metrics.
- `services/laya-sidecar/` — Python package shell for a persistent local inference sidecar.
- `integrations/` — host setup assets for Claude Code, Codex, and Cursor.
- `benchmarks/` — isolated four-arm coding-agent task harness and ten starter fixtures.

## Requirements

- Node.js 20 or later and pnpm 9.6 or later.
- Python 3.11 or later and [uv](https://docs.astral.sh/uv/).

## Setup and checks

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Python sidecar checks:

```sh
cd services/laya-sidecar
uv sync --extra dev
uv run ruff check src tests
uv run mypy src
uv run pytest
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Current host setup and MCP tools are described below and in the integration-specific readmes.

Task benchmark planning and quota-free smoke: `pnpm benchmark:tasks plan` and `pnpm benchmark:tasks smoke`. See [`benchmarks/README.md`](benchmarks/README.md) before a live Codex run.

## CLI

After the CLI is published to npm, install it globally with npm:

```sh
npm install --global thinktrim
```

Or install it globally with pnpm:

```sh
pnpm add --global thinktrim
```

Then, from the repository you want to use with Codex:

```sh
thinktrim doctor
thinktrim setup codex --dry-run
thinktrim setup codex
```

Trust the project in Codex and reopen it so its project MCP configuration is loaded. To use the workspace source during development, run:

```sh
node packages/cli/dist/cli.js --help
```

Other CLI commands:

```sh
thinktrim init
thinktrim index
thinktrim setup all --dry-run
thinktrim uninstall codex --dry-run
```

Setup commands merge the host MCP configuration and refuse to replace a customized ThinkTrim entry. See [`packages/cli/README.md`](packages/cli/README.md) for command and workspace details.
