# Laya local sidecar

The Node client in `node/client.mjs` starts one persistent Python process. Python reads bounded JSONL requests from stdin and writes JSONL replies to stdout. Model diagnostics go to stderr; the Node client drains stderr and reports byte counts only. It never logs request bodies or raw model errors.

## Install and run

From this directory:

```sh
uv sync --extra dev --locked
uv run python -u -m thinktrim_laya_sidecar
```

The default development install includes protocol tooling, not Laya or weights. To run inference, install the optional model dependency in the same Python environment with `uv sync --extra model --extra dev --locked`. Laya downloads a checkpoint on first prediction if it is not already cached; no weights are included in npm or VSIX packages. The [current Laya Router documentation](https://github.com/NandhaKishorM/laya/blob/main/laya/router.py) supports `Router(device=...)`, `predict(state, questions, model=...)`, and `predict_batch(requests)`. The [Laya installation guide](https://github.com/NandhaKishorM/laya/blob/main/README.md) documents Python, CPU/GPU setup, and checkpoint downloads.

`THINKTRIM_LAYA_DEVICE` accepts `auto` (default), `cpu`, `cuda`, or `mps`. The Router and checkpoint are loaded lazily on the first prediction; a pinned `model` may be `english`, `multilingual`, or `typed-decisions`. Health can report `model_unavailable` if Laya is not installed. A failed model load or inference returns `model_unavailable` without exposing the underlying exception in the protocol.

## Protocol V1

Each line is one UTF-8 JSON object, at most 1 MiB including the newline. Requests have `v`, a string `id`, an `op`, and optional `params`. Replies have the same `v` and `id`, `ok`, and either `result` or a structured `error`. Operations are `health`, `capabilities`, `version`, `preload`, `predict`, `predictBatch`, and `shutdown`.

```json
{"v":1,"id":"1","op":"predict","params":{"state":"A parser file","questions":{"relevant":{"type":"noul","instructions":"Is this relevant?"}}}}
```

`predict` accepts Laya's `state`, `questions`, and optional `model` and `lang` hint. `preload` accepts a model name and loads only that checkpoint. `predictBatch` accepts 1–16 such requests. The sidecar limits each request to 32 questions. Responses are bounded; invalid frames and unsafe output become fixed error codes. No remote endpoint is used for prediction, though a first model download may contact the model hub if the checkpoint is not cached.

The Node client performs a health handshake, correlates IDs, enforces startup and request deadlines, and restarts after a crash or malformed output on the next request. Laya inference is synchronous; cancelling or timing out an in-flight call terminates the worker and all its pending requests. The next request creates a new worker. Graceful shutdown sends `shutdown` and waits briefly before terminating a stuck worker.

## Tests

```sh
uv run --extra dev ruff check src tests
uv run --extra dev mypy src
uv run --extra dev pytest
node --test node/client.test.mjs
```

The Python and Node suites use mocked model/worker behavior. The real-model smoke test is separately gated because it may download weights and require substantial memory:

```sh
uv sync --extra model --extra dev --locked
THINKTRIM_RUN_LAYA_REAL=1 uv run --extra model --extra dev pytest tests/test_real_model.py
```

In PowerShell, set `$env:THINKTRIM_RUN_LAYA_REAL = "1"` before the `uv run` command.
