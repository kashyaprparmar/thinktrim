"""Lazy adapter to the current public Laya Router API."""

from __future__ import annotations

import importlib
import importlib.metadata
import os
import sys
from contextlib import redirect_stdout
from typing import Any, Protocol, cast


class RouterLike(Protocol):
    def predict(
        self,
        state: str | dict[str, Any] | list[Any],
        questions: dict[str, Any],
        model: str | None = None,
        lang: str | None = None,
    ) -> dict[str, Any]: ...

    def predict_batch(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]: ...

    def preload(self, models: list[str]) -> Any: ...


class ModelUnavailable(Exception):
    """Laya is absent or its model could not load."""


class LayaRuntime:
    def __init__(self, *, device: str | None = None, router: RouterLike | None = None) -> None:
        requested = device or os.environ.get("THINKTRIM_LAYA_DEVICE", "auto")
        if requested not in {"auto", "cpu", "cuda", "mps"}:
            raise ValueError("unsupported device")
        self.device = requested
        self._router = router

    @property
    def loaded(self) -> bool:
        return self._router is not None

    @staticmethod
    def installed_version() -> str | None:
        try:
            return importlib.metadata.version("laya")
        except importlib.metadata.PackageNotFoundError:
            return None

    def _get_router(self) -> RouterLike:
        if self._router is None:
            try:
                with redirect_stdout(sys.stderr):
                    router_class = importlib.import_module("laya").Router
                    self._router = cast(
                        RouterLike,
                        router_class(device=None if self.device == "auto" else self.device),
                    )
            except Exception as exc:
                raise ModelUnavailable from exc
        return self._router

    def predict(self, request: dict[str, Any]) -> dict[str, Any]:
        router = self._get_router()
        try:
            with redirect_stdout(sys.stderr):
                return router.predict(
                    request["state"],
                    request["questions"],
                    model=request.get("model"),
                    lang=request.get("lang"),
                )
        except Exception as exc:
            raise ModelUnavailable from exc

    def predict_batch(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        router = self._get_router()
        try:
            with redirect_stdout(sys.stderr):
                return router.predict_batch(requests)
        except Exception as exc:
            raise ModelUnavailable from exc

    def preload(self, model: str) -> dict[str, Any]:
        router = self._get_router()
        try:
            with redirect_stdout(sys.stderr):
                router.preload([model])
            return {"loaded": True, "model": model, "device": self.device}
        except Exception as exc:
            raise ModelUnavailable from exc
