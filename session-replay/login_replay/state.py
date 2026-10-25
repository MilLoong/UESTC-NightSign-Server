"""Validate state locally before any network request."""
import base64
import hashlib
import hmac
import json
import os
import stat
from pathlib import Path
from .protocol import parse_request, session_inputs, unwrap_business, extract_code

APP_ID = "wxaa78bf2905f01cee"


def load_state(path):
    path = Path(path)
    if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("STATE_PERMISSIONS_REQUIRE_0600")
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("STATE_TOO_LARGE")
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("appId") != APP_ID or state.get("version") != 1:
        raise ValueError("STATE_IDENTITY_MISMATCH")
    request = base64.b64decode(state["httpRequest"], validate=True)
    inputs = session_inputs(state, parse_request(request)[2])
    response = base64.b64decode(state["capturedHttpResponse"], validate=True)
    head, separator, body = response.partition(b"\r\n\r\n")
    if not separator or not head.startswith(b"HTTP/1.1 200 "):
        raise ValueError("CAPTURE_RESPONSE_INVALID")
    code = extract_code(unwrap_business(state, body, inputs))
    if not hmac.compare_digest(hashlib.sha256(code.encode()).hexdigest(),
                               state["capturedCodeHash"]):
        raise ValueError("CAPTURE_HASH_MISMATCH")
    return state
