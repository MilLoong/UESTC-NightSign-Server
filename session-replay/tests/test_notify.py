import json
import tempfile
import unittest
from pathlib import Path
from login_replay.notify import notification, send_notification


class NotificationTests(unittest.TestCase):
    def test_no_private_fields_forwarded(self):
        message = notification({'stage': 'secret', 'businessDate': 'secret', 'error': 'secret'})
        self.assertNotIn('secret', json.dumps(message))
        self.assertIn('不确定', notification({'stage': 'result_unknown'})['title'])

    def test_optional_config_and_sanitized_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notify.json'
            self.assertEqual(send_notification({}, path), {'notification': 'disabled'})
            path.write_text(json.dumps({'sendKey': 'SCT' + 'x' * 20}), encoding='utf-8')
            class Broken:
                def open(self, request, timeout):
                    raise RuntimeError('private transport details')
            self.assertEqual(send_notification({}, path, Broken()), {'notification': 'failed'})

    def test_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notify.json'
            path.write_text(json.dumps({'sendKey': 'SCT' + 'x' * 20}), encoding='utf-8')
            class Response:
                status = 200
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, limit): return b'{"code":0}'
            class Opener:
                def open(self, request, timeout):
                    self.request, self.timeout = request, timeout
                    return Response()
            opener = Opener()
            self.assertEqual(send_notification({}, path, opener), {'notification': 'accepted'})
            self.assertEqual(opener.request.get_method(), 'POST')
            self.assertEqual(opener.timeout, 8)
