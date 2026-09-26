"""Bounded JSONL/RPC protocol. No request content is written to stderr."""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from typing import Any, BinaryIO, TextIO

from . import __version__
from .runtime import LayaRuntime, ModelUnavailable

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 1_048_576
MAX_BATCH = 16
MAX_QUESTIONS = 32
MODEL_NAMES = {"english", "multilingual", "typed-decisions"}


class ProtocolFault(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _validate_prediction(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {"state", "questions", "model", "lang"}:
        raise ProtocolFault("invalid_request")
    state = value.get("state")
    questions = value.get("questions")
    model = value.get("model")
    language = value.get("lang")
    if not isinstance(state, (str, dict, list)):
        raise ProtocolFault("invalid_request")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= MAX_QUESTIONS:
        raise ProtocolFault("invalid_request")
    if not all(isinstance(key, str) and key for key in questions):
        raise ProtocolFault("invalid_request")
    if model is not None and model not in MODEL_NAMES:
        raise ProtocolFault("invalid_request")
    if language is not None and (
        not isinstance(language, str)
        or not 2 <= len(language) <= 35
        or not all(character.isalnum() or character in "-_" for character in language)
    ):
        raise ProtocolFault("invalid_request")
    for question in questions.values():
        if not isinstance(question, dict) or question.get("type") not in {
            "noul",
            "choice",
            "score",
        }:
            raise ProtocolFault("invalid_request")
        if question["type"] == "choice" and not isinstance(question.get("criteria"), dict):
            raise ProtocolFault("invalid_request")
        if question["type"] == "score" and not isinstance(question.get("criteria"), list):
            raise ProtocolFault("invalid_request")
    return value


def _response(request_id: str | None, *, result: object = None, error: str | None = None) -> str:
    body: dict[str, object] = {"v": PROTOCOL_VERSION, "id": request_id, "ok": error is None}
    if error is None:
        body["result"] = result
    else:
        body["error"] = {"code": error, "message": error.replace("_", " ")}
    line = json.dumps(body, separators=(",", ":"), allow_nan=False) + "\n"
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        if error is not None:
            raise ProtocolFault("invalid_output")
        return _response(request_id, error="invalid_output")
    return line


def dispatch(message: object, runtime: LayaRuntime) -> tuple[str, bool]:
    if not isinstance(message, Mapping):
        raise ProtocolFault("invalid_request")
    request_id = message.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise ProtocolFault("invalid_request")
    if message.get("v") != PROTOCOL_VERSION:
        return _response(request_id, error="unsupported_version"), False
    op = message.get("op")
    if not isinstance(op, str):
        return _response(request_id, error="invalid_request"), False
    try:
        if op == "health":
            result: object = {
                "status": "ready" if runtime.installed_version() else "model_unavailable",
                "loaded": runtime.loaded,
                "device": runtime.device,
            }
        elif op == "capabilities":
            result = {
                "protocolVersion": PROTOCOL_VERSION,
                "operations": [
                    "health",
                    "capabilities",
                    "version",
                    "preload",
                    "predict",
                    "predictBatch",
                    "shutdown",
                ],
                "questionTypes": ["noul", "choice", "score"],
                "maxBatch": MAX_BATCH,
                "maxQuestions": MAX_QUESTIONS,
                "maxLineBytes": MAX_LINE_BYTES,
                "device": runtime.device,
            }
        elif op == "version":
            result = {
                "protocol": PROTOCOL_VERSION,
                "sidecar": __version__,
                "laya": runtime.installed_version(),
            }
        elif op == "preload":
            params = message.get("params")
            model = params.get("model", "english") if isinstance(params, Mapping) else "english"
            if model not in MODEL_NAMES:
                raise ProtocolFault("invalid_request")
            result = runtime.preload(model)
        elif op == "predict":
            result = runtime.predict(_validate_prediction(message.get("params")))
        elif op == "predictBatch":
            params = message.get("params")
            if not isinstance(params, list) or not 1 <= len(params) <= MAX_BATCH:
                raise ProtocolFault("invalid_request")
            result = runtime.predict_batch([_validate_prediction(item) for item in params])
        elif op == "shutdown":
            return _response(request_id, result={"stopping": True}), True
        else:
            raise ProtocolFault("unknown_operation")
        return _response(request_id, result=result), False
    except ProtocolFault as exc:
        return _response(request_id, error=exc.code), False
    except ModelUnavailable:
        return _response(request_id, error="model_unavailable"), False
    except (TypeError, ValueError, OverflowError):
        return _response(request_id, error="invalid_output"), False


def serve(
    runtime: LayaRuntime, input_stream: BinaryIO | None = None, output: TextIO | None = None
) -> None:
    source = input_stream or sys.stdin.buffer
    sink = output or sys.stdout
    while True:
        line = source.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            # An oversized or unterminated frame cannot be safely resynchronized.
            sink.write(_response(None, error="invalid_json"))
            sink.flush()
            return
        try:
            message = json.loads(line, parse_constant=lambda _value: _reject_non_json_constant())
            reply, stop = dispatch(message, runtime)
        except (json.JSONDecodeError, UnicodeDecodeError, ProtocolFault, ValueError):
            reply, stop = _response(None, error="invalid_json"), False
        sink.write(reply)
        sink.flush()
        if stop:
            return


def _reject_non_json_constant() -> None:
    raise ValueError("non-JSON numeric constant")
