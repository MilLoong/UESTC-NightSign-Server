import base64
import json
import os
import tempfile
import unittest
from pathlib import Path

from capture.windows.build_state import build_state, load_trace, write_state
from fixture_session import CODE, make_state

APP_ID = 'wxaa78bf2905f01cee'


def events_for(state, code=None):
    secret = base64.b64decode(state['mmtlsSecret']).hex()
    key = base64.b64decode(state['businessResponseKey']).hex()
    aad = base64.b64decode(state['businessResponseAad']).hex() if state['businessResponseAad'] else ''
    return [
        {'event': 'trace.mmtls-expand', 'detail': {'secretHex': secret}},
        {'event': 'trace.mmtls-inner-gcm', 'detail': {'keyHex': key, 'aadHex': aad}},
        {'event': 'trace.main-send', 'binaryFile': 'req.bin'},
        {'event': 'trace.main-recv', 'binaryFile': 'resp.bin'},
        {'event': 'active.login-code', 'detail': {'appId': APP_ID, 'code': code or CODE}},
    ]


def binaries_for(state):
    return {
        'req.bin': base64.b64decode(state['httpRequest']),
        'resp.bin': base64.b64decode(state['capturedHttpResponse']),
    }


class BuildStateTests(unittest.TestCase):
    def setUp(self):
        self.state = make_state()
        self.binaries = binaries_for(self.state)

    def read(self, name):
        return self.binaries[name]

    def test_builds_matching_state(self):
        built = build_state(events_for(self.state), self.read)
        self.assertEqual(built['appId'], APP_ID)
        self.assertEqual(built['version'], 1)
        self.assertEqual(built['capturedCodeHash'], self.state['capturedCodeHash'])
        self.assertEqual(built['httpRequest'], self.state['httpRequest'])
        self.assertEqual(built['capturedHttpResponse'], self.state['capturedHttpResponse'])
        self.assertIn('preparedAt', built)

    def test_native_code_mismatch_is_rejected(self):
        with self.assertRaises(ValueError) as raised:
            build_state(events_for(self.state, code='0' + 'B' * 31), self.read)
        self.assertEqual(str(raised.exception), 'CAPTURE_INCONSISTENT_WITH_NATIVE_CODE')

    def test_ambiguous_secret_is_rejected(self):
        events = events_for(self.state)
        events.insert(0, {'event': 'trace.mmtls-expand', 'detail': {'secretHex': '00' * 32}})
        with self.assertRaises(ValueError) as raised:
            build_state(events, self.read)
        self.assertEqual(str(raised.exception), 'CAPTURE_SECRET_AMBIGUOUS')

    def test_missing_wire_pair_is_rejected(self):
        events = [event for event in events_for(self.state) if event['event'] != 'trace.main-recv']
        with self.assertRaises(ValueError) as raised:
            build_state(events, self.read)
        self.assertEqual(str(raised.exception), 'CAPTURE_WIRE_MISSING')

    def test_write_state_is_exclusive_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            write_state(self.state, path)
            if os.name == 'posix':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                write_state(self.state, path)
            write_state(self.state, path, force=True)

    def test_load_trace_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = events_for(self.state)
            for name, blob in self.binaries.items():
                (root / name).write_bytes(blob)
            (root / 'events.json').write_text(json.dumps(events), encoding='utf-8')
            loaded, read = load_trace(root)
            built = build_state(loaded, read)
            self.assertEqual(built['capturedCodeHash'], self.state['capturedCodeHash'])


if __name__ == '__main__':
    unittest.main()
