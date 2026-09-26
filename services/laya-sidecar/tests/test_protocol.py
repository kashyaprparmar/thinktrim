"""Mocked protocol tests; no model weights or network access required."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from thinktrim_laya_sidecar.protocol import MAX_LINE_BYTES, PROTOCOL_VERSION, dispatch, serve
from thinktrim_laya_sidecar.runtime import LayaRuntime


class FakeRouter:
    def __init__(self) -> None:
        self.last_lang: str | None = None
        self.preloaded: list[str] = []

    def predict(
        self,
        state: str | dict[str, Any] | list[Any],
        questions: dict[str, Any],
        model: str | None = None,
        lang: str | None = None,
    ) -> dict[str, Any]:
        self.last_lang = lang
        return {
            "model": model or "english",
            "answers": {"check": {"type": "noul", "noul": 0.8}},
            "usage": {"input_tokens": 2, "output_tokens": 1},
        }

    def predict_batch(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            self.predict(item["state"], item["questions"], item.get("model")) for item in requests
        ]

    def preload(self, models: list[str]) -> None:
        self.preloaded.extend(models)


def frame(request_id: str, op: str, params: object = None) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "id": request_id, "op": op, "params": params}


PREDICTION = {"state": "A parser file", "questions": {"check": {"type": "noul"}}}


def test_all_operations_with_mock_router() -> None:
    router = FakeRouter()
    runtime = LayaRuntime(device="cpu", router=router)
    for op in ("health", "capabilities", "version"):
        reply, stop = dispatch(frame(op, op), runtime)
        assert json.loads(reply)["ok"] is True
        assert stop is False
    prediction, _ = dispatch(frame("one", "predict", PREDICTION), runtime)
    assert json.loads(prediction)["result"]["answers"]["check"]["noul"] == 0.8
    localized, _ = dispatch(
        frame("localized", "predict", {**PREDICTION, "lang": "hi"}), runtime
    )
    assert json.loads(localized)["ok"] is True
    assert router.last_lang == "hi"
    preload, _ = dispatch(frame("preload", "preload", {"model": "multilingual"}), runtime)
    assert json.loads(preload)["ok"] is True
    assert router.preloaded == ["multilingual"]
    batch, _ = dispatch(frame("two", "predictBatch", [PREDICTION, PREDICTION]), runtime)
    assert len(json.loads(batch)["result"]) == 2
    shutdown, stop = dispatch(frame("three", "shutdown"), runtime)
    assert json.loads(shutdown)["result"]["stopping"] is True
    assert stop is True


def test_invalid_json_and_invalid_request_do_not_echo_source() -> None:
    runtime = LayaRuntime(device="cpu", router=FakeRouter())
    input_stream = io.BytesIO(
        b'{"private":"secret"\n'
        + b'{"v":1,"id":"nonfinite","op":"health","params":NaN}\n'
        + json.dumps(frame("valid", "predict", PREDICTION)).encode()
        + b"\n"
        + json.dumps(frame("bad", "predict", {"state": "secret", "questions": {}})).encode()
        + b"\n"
        + json.dumps(frame("done", "shutdown")).encode()
        + b"\n"
    )
    output = io.StringIO()
    serve(runtime, input_stream, output)
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [item["ok"] for item in replies] == [False, False, True, False, True]
    assert replies[0]["error"]["code"] == "invalid_json"
    assert replies[1]["error"]["code"] == "invalid_json"
    assert replies[3]["error"]["code"] == "invalid_request"
    assert "secret" not in output.getvalue()


def test_version_and_batch_limits() -> None:
    runtime = LayaRuntime(device="cpu", router=FakeRouter())
    version, _ = dispatch({**frame("v", "health"), "v": 100}, runtime)
    assert json.loads(version)["error"]["code"] == "unsupported_version"
    batch, _ = dispatch(frame("b", "predictBatch", [PREDICTION] * 17), runtime)
    assert json.loads(batch)["error"]["code"] == "invalid_request"
    with pytest.raises(ValueError, match="unsupported device"):
        LayaRuntime(device="invalid")


def test_lazy_model_loading_and_device_selection() -> None:
    constructions: list[str | None] = []

    def build_router(*, device: str | None) -> FakeRouter:
        constructions.append(device)
        return FakeRouter()

    runtime = LayaRuntime(device="cuda")
    assert runtime.loaded is False
    with patch("thinktrim_laya_sidecar.runtime.importlib.import_module") as importer:
        importer.return_value = SimpleNamespace(Router=build_router)
        runtime.predict(PREDICTION)
        runtime.predict(PREDICTION)
    assert constructions == ["cuda"]
    assert runtime.loaded is True


def test_model_failure_and_oversized_frame_are_bounded() -> None:
    class FailingRouter(FakeRouter):
        def predict(
            self,
            state: str | dict[str, Any] | list[Any],
            questions: dict[str, Any],
            model: str | None = None,
            lang: str | None = None,
        ) -> dict[str, Any]:
            raise RuntimeError("secret model diagnostic")

    runtime = LayaRuntime(device="cpu", router=FailingRouter())
    reply, _ = dispatch(frame("failure", "predict", PREDICTION), runtime)
    assert json.loads(reply)["error"]["code"] == "model_unavailable"
    assert "secret" not in reply
    output = io.StringIO()
    serve(runtime, io.BytesIO(b"x" * (MAX_LINE_BYTES + 1) + b"\n"), output)
    assert json.loads(output.getvalue())["error"]["code"] == "invalid_json"

    class OversizedRouter(FakeRouter):
        def predict(
            self,
            state: str | dict[str, Any] | list[Any],
            questions: dict[str, Any],
            model: str | None = None,
            lang: str | None = None,
        ) -> dict[str, Any]:
            return {"payload": "x" * MAX_LINE_BYTES}

    huge = LayaRuntime(device="cpu", router=OversizedRouter())
    reply, _ = dispatch(frame("large", "predict", PREDICTION), huge)
    assert json.loads(reply)["error"]["code"] == "invalid_output"


def test_python_process_is_persistent_and_shuts_down() -> None:
    env = {**os.environ, "THINKTRIM_LAYA_DEVICE": "cpu"}
    process = subprocess.Popen(
        [sys.executable, "-u", "-m", "thinktrim_laya_sidecar"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert process.stdin is not None and process.stdout is not None
        for index, op in enumerate(("version", "capabilities", "shutdown")):
            process.stdin.write(json.dumps(frame(str(index), op)) + "\n")
            process.stdin.flush()
            reply = json.loads(process.stdout.readline())
            assert reply["id"] == str(index)
            assert reply["ok"] is True
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
