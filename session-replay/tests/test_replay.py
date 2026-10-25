import base64
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from cryptography.exceptions import InvalidTag
from fixture_session import make_state, CODE
from login_replay.state import load_state
from login_replay.protocol import parse_request, records, extract_code
from login_replay.__main__ import main


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "state.json"

    def write_state(self, state):
        self.path.write_text(json.dumps(state), encoding="utf-8")
        self.path.chmod(0o600)

    def invoke(self, extra=()):
        output = io.StringIO()
        with patch("sys.argv", ["replay", "--state", str(self.path),
                                "--ledger", str(self.root / "ledger.sqlite"), *extra]):
            with contextlib.redirect_stdout(output):
                result = main()
        return result, output.getvalue()

    def test_synthetic_roundtrip(self):
        self.write_state(make_state())
        self.assertEqual(load_state(self.path)["appId"], "wxaa78bf2905f01cee")

    def test_wrong_app(self):
        state = make_state()
        state["appId"] = "other"
        self.write_state(state)
        with self.assertRaises(ValueError):
            load_state(self.path)

    def test_bad_hash(self):
        state = make_state()
        state["capturedCodeHash"] = "0" * 64
        self.write_state(state)
        with self.assertRaises(ValueError):
            load_state(self.path)

    def test_tamper(self):
        state = make_state()
        response = bytearray(base64.b64decode(state["capturedHttpResponse"]))
        response[-1] ^= 1
        state["capturedHttpResponse"] = base64.b64encode(response).decode()
        self.write_state(state)
        with self.assertRaises(InvalidTag):
            load_state(self.path)

    def test_foreign_destination(self):
        request = base64.b64decode(make_state()["httpRequest"])
        with self.assertRaises(ValueError):
            parse_request(request.replace(b"szextshort.weixin.qq.com", b"example.com"))

    def test_truncated_records(self):
        with self.assertRaises(ValueError):
            records(b"\x16")

    def test_rejected_business(self):
        with self.assertRaises(ValueError):
            extract_code(b"\x0a\x02\x08\x01\x1a\x20" + CODE.encode())

    def test_default_never_requests_network(self):
        self.write_state(make_state())
        with patch("login_replay.__main__.request_code") as request:
            result, output = self.invoke()
        request.assert_not_called()
        self.assertEqual(result, 0)
        self.assertNotIn(CODE, output)

    def test_original_code_rejected(self):
        self.write_state(make_state())
        with patch("login_replay.__main__.request_code", return_value=CODE):
            result, output = self.invoke(["--online"])
        self.assertEqual(result, 1)
        self.assertNotIn(CODE, output)

    def test_duplicate_code_rejected(self):
        self.write_state(make_state())
        fresh = "0" + "B" * 31
        with patch("login_replay.__main__.request_code", return_value=fresh):
            first, output = self.invoke(["--online"])
            second, _ = self.invoke(["--online"])
        self.assertEqual((first, second), (0, 1))
        self.assertNotIn(fresh, output)

    def test_exclusive_code_output(self):
        self.write_state(make_state())
        destination = self.root / "code.txt"
        with patch("login_replay.__main__.request_code", return_value="0" + "B" * 31):
            result, output = self.invoke(["--online", "--code-file", str(destination)])
        self.assertEqual(result, 0)
        self.assertEqual(destination.read_text(), "0" + "B" * 31)
        self.assertNotIn(destination.read_text(), output)

    @unittest.skipUnless(os.name == "posix", "POSIX permission semantics")
    def test_public_state_rejected(self):
        self.write_state(make_state())
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            load_state(self.path)


if __name__ == "__main__":
    unittest.main()
