# ThinkTrim for VS Code

The extension provides the VS Code host surface for ThinkTrim. It composes the existing repository indexer, context ranker, core decision engine, confidence policy, and provider adapters; it does not implement another decision engine.

Repository ranking is deterministic and makes no model requests. The selected provider is used by the explicit connection check: the loopback Laya HTTP service or hosted Jev. Provider API keys are stored in VS Code `SecretStorage`, never in workspace settings. A backend connectivity check sends a fixed synthetic request without repository data. Provider reranking remains disabled until there is calibration evidence for the exact model and decision category.

`pnpm --filter @thinktrim/vscode-extension build` bundles the extension entry point for the VS Code extension host. `pnpm --filter @thinktrim/vscode-extension typecheck` checks the TypeScript source against the VS Code API declarations.

The Command Palette provides ThinkTrim: Status, Rank Context, Analyze Selection, Open Trace, Test Backend, Configure Backend, Clear Cache, and Doctor. The Explorer sidebar reports completed ranking runs, selection analyses, cache state, indexing and ranking latency, and an estimated reduction from all indexed paths to the displayed metadata shortlist. Token estimates use roughly four characters per token and are labelled estimated; they do not represent tokens read by an agent. VS Code does not expose frontier context usage, so frontier token savings are reported as unavailable.

Rank Context uses a local deterministic policy. Analyze Selection uses the selected text for local repository search, but passes only the file path to the ranking policy. Provider inference is currently used only by Test Backend, which uses the shared core engine and a fixed synthetic request. Jev tests require explicit user confirmation because they can incur provider charges.
