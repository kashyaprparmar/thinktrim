"""Opt-in real-model smoke test; may download checkpoint weights."""

from __future__ import annotations

import importlib
import os

import pytest

from thinktrim_laya_sidecar.runtime import LayaRuntime


@pytest.mark.skipif(os.environ.get("THINKTRIM_RUN_LAYA_REAL") != "1", reason="real model gate")
def test_real_laya_predict_and_batch() -> None:
    importlib.import_module("laya")
    runtime = LayaRuntime(device=os.environ.get("THINKTRIM_LAYA_DEVICE", "cpu"))
    request = {
        "state": "The parser crashes on empty files",
        "questions": {
            "parser_relevant": {"type": "noul", "instructions": "Is parser work relevant?"}
        },
        "model": "english",
    }
    single = runtime.predict(request)
    assert 0 <= single["answers"]["parser_relevant"]["noul"] <= 1
    batch = runtime.predict_batch([request, request])
    assert len(batch) == 2
    assert all("answers" in item for item in batch)
