"""Run the sidecar as one persistent stdin/stdout JSONL process."""

from __future__ import annotations

from .protocol import serve
from .runtime import LayaRuntime


def main() -> None:
    serve(LayaRuntime())


if __name__ == "__main__":
    main()
