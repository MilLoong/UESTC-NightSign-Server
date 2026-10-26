import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from login_replay.checkin import FlowError, Ledger, run_checkin

CHINA = timezone(timedelta(hours=8))
NOW = datetime(2026, 10, 25, 21, 30, tzinfo=CHINA)
CODE = '0' + 'B' * 31
TICKET = 'T' * 43


def make_config(root, session='S' * 32):
    return {
        'session': session,
        'userAgent': 'Test/1.0',
        'location': {'latitude': 31, 'longitude': 121, 'coordinateSystemCode': 'gcj02'},
        'ledger': str(root / 'ledger.sqlite'),
    }


class FakeHttp:
    def __init__(self, **overrides):
        self.calls = []
        self.overrides = overrides

    def __call__(self, method, path, headers, body=None):
        self.calls.append({'method': method, 'path': path, 'headers': headers, 'body': body})
        for needle, reply in self.overrides.items():
            if path.endswith(needle):
                return reply() if callable(reply) else reply
        if path.endswith('/today'):
            return {'code': 0, 'ok': True, 'data': {'businessDate': '2026-10-25', 'recordStatusCode': 'PENDING'}}
        if path.endswith('/effective'):
            return {'code': 0, 'ok': True, 'data': {
                'effective': True, 'studentCheckinStartOffsetMinute': 1260,
                'studentCheckinEndOffsetMinute': 1410}}
        if path.endswith('/available-locations'):
            return {'code': 0, 'ok': True, 'data': [{'latitude': 31.0005, 'longitude': 121, 'radiusMeter': 140}]}
        if '/map/reverse' in path:
            return {'code': 0, 'ok': True, 'data': '四川省成都市'}
        if path.endswith('/checkin-ticket'):
            return {'code': 0, 'ok': True, 'data': {'ticket': TICKET}}
        if path.endswith('/checkin'):
            return {'code': 0, 'ok': True, 'data': True}
        raise AssertionError('unexpected path: ' + path)


class CheckinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_verify_exchanges_ticket_without_submitting(self):
        http = FakeHttp()
        result = run_checkin(make_config(self.root), lambda: CODE, http=http, now=lambda: NOW)
        self.assertEqual(result['stage'], 'authorization_verified')
        self.assertFalse(result['checkinSubmitted'])
        self.assertFalse(any(call['path'].endswith('/checkin') for call in http.calls))
        ticket_call = next(call for call in http.calls if call['path'].endswith('/checkin-ticket'))
        self.assertEqual(ticket_call['headers']['Cookie'], 'SESSION=' + 'S' * 32)
        self.assertEqual(ticket_call['headers']['platform'], 'mp-weixin')
        self.assertEqual(ticket_call['body'], {'code': CODE})

    def test_submit_is_confirmed_by_readback(self):
        seen = {'count': 0}

        def today():
            seen['count'] += 1
            status = 'CHECKED_IN' if seen['count'] > 1 else 'PENDING'
            return {'code': 0, 'ok': True, 'data': {'businessDate': '2026-10-25', 'recordStatusCode': status}}

        http = FakeHttp(**{'/today': today})
        result = run_checkin(make_config(self.root), lambda: CODE, http=http, submit=True, now=lambda: NOW, sleep=lambda _: None)
        self.assertEqual(result['stage'], 'checked_in_confirmed')
        submit = next(call for call in http.calls if call['path'].endswith('/checkin'))
        self.assertEqual(submit['headers']['X-Checkin-Ticket'], TICKET)
        self.assertEqual(submit['headers']['platform'], 'h5')
        self.assertEqual(submit['body']['latitude'], 31)
        self.assertFalse(submit['body']['locationEnabled'])
        ledger = Ledger(self.root / 'ledger.sqlite')
        self.assertTrue(ledger.exists('2026-10-25'))

    def test_already_checked_in_never_requests_a_code(self):
        http = FakeHttp(**{'/today': {'code': 0, 'ok': True, 'data': {
            'businessDate': '2026-10-25', 'recordStatusCode': 'CHECKED_IN'}}})
        calls = []
        result = run_checkin(make_config(self.root), lambda: calls.append(1) or CODE, http=http, submit=True, now=lambda: NOW)
        self.assertEqual(result['stage'], 'already_checked_in')
        self.assertEqual(calls, [])

    def test_outside_window_never_submits(self):
        http = FakeHttp()
        early = datetime(2026, 10, 25, 10, 0, tzinfo=CHINA)
        with self.assertRaises(FlowError) as raised:
            run_checkin(make_config(self.root), lambda: CODE, http=http, submit=True, now=lambda: early)
        self.assertEqual(raised.exception.code, 'OUTSIDE_CHECKIN_WINDOW')
        self.assertFalse(any(call['path'].endswith('/checkin') for call in http.calls))

    def test_outside_fence_is_rejected(self):
        http = FakeHttp(**{'/available-locations': {'code': 0, 'ok': True, 'data': [
            {'latitude': 30.0, 'longitude': 121, 'radiusMeter': 10}]}})
        with self.assertRaises(FlowError) as raised:
            run_checkin(make_config(self.root), lambda: CODE, http=http, now=lambda: NOW)
        self.assertEqual(raised.exception.code, 'OUTSIDE_ALLOWED_LOCATION')

    def test_previous_attempt_blocks_submission(self):
        Ledger(self.root / 'ledger.sqlite').claim('2026-10-25', NOW.isoformat())
        http = FakeHttp()
        with self.assertRaises(FlowError) as raised:
            run_checkin(make_config(self.root), lambda: CODE, http=http, submit=True, now=lambda: NOW)
        self.assertEqual(raised.exception.code, 'ATTEMPT_ALREADY_RECORDED')

    def test_ticket_rejection_is_surfaced(self):
        http = FakeHttp(**{'/checkin-ticket': {'code': 46001, 'ok': False}})
        with self.assertRaises(FlowError) as raised:
            run_checkin(make_config(self.root), lambda: CODE, http=http, now=lambda: NOW)
        self.assertEqual(raised.exception.code, 'SCHOOL_46001')

    def test_missing_session_is_rejected_before_network(self):
        http = FakeHttp()
        with self.assertRaises(FlowError) as raised:
            run_checkin(make_config(self.root, session=''), lambda: CODE, http=http, now=lambda: NOW)
        self.assertEqual(raised.exception.code, 'SCHOOL_SESSION_REQUIRED')
        self.assertEqual(http.calls, [])


if __name__ == '__main__':
    unittest.main()
