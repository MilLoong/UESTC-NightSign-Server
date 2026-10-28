"""One-shot school check-in using a replayed code and the user's own session.

Runtime: Python 3.10+, cryptography (only for loading the captured state).
Does not access WeChat, Frida or the capture machine: the user supplies the
school SESSION; the replayed code comes from login_replay.transport.
"""
import argparse
import json
import math
import os
import re
import sqlite3
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .state import load_state
from .transport import request_code
from .notify import send_notification

ORIGIN = 'https://jzsz.uestc.edu.cn'
API = '/daily-checkin/api/'
TICKET_PATH = '/platform-app/api/auth/checkin-ticket'
SUBMIT_PATH = API + 'student-checkin-record/checkin'
CHINA = timezone(timedelta(hours=8))
SESSION_RE = re.compile(r'^[A-Za-z0-9._~-]{10,512}$')
CODE_RE = re.compile(r'^[A-Za-z0-9_-]{24,128}$')
TICKET_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')
CLOSED_RECORD = {'CHECKED_IN', 'STUDENT_REPORTED', 'INSTRUCTOR_REPORTED', 'EXEMPT'}


class FlowError(Exception):
    def __init__(self, code, detail=''):
        super().__init__(code)
        self.code = code
        self.detail = detail


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def china_now():
    return datetime.now(CHINA)


def default_http(method, path, headers, body=None, timeout=15):
    request = Request(
        ORIGIN + path,
        data=None if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        headers=headers, method=method,
    )
    try:
        response = build_opener(NoRedirect).open(request, timeout=timeout)
        status, raw = response.code, response.read(1024 * 1024 + 1)
    except HTTPError as error:
        status, raw = error.code, error.read(1024 * 1024 + 1)
    except (URLError, TimeoutError, OSError):
        raise FlowError('SCHOOL_NETWORK') from None
    if len(raw) > 1024 * 1024:
        raise FlowError('SCHOOL_RESPONSE_TOO_LARGE')
    if status == 401:
        raise FlowError('SCHOOL_401')
    if not 200 <= status < 300:
        raise FlowError(f'SCHOOL_HTTP_{status}')
    try:
        return json.loads(raw.decode('utf-8-sig'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise FlowError('SCHOOL_RESPONSE_INVALID') from None


def call(http, path, headers, body=None):
    result = http('GET' if body is None else 'POST', path, headers, body)
    if not isinstance(result, dict):
        raise FlowError('SCHOOL_RESPONSE_INVALID')
    if result.get('code') != 0 or result.get('ok') is False:
        code = result.get('code')
        detail = result.get('msg') or result.get('message') or ''
        raise FlowError(f'SCHOOL_{code}' if type(code) is int else 'SCHOOL_AUTH_FAILED', str(detail)[:200])
    return result.get('data')


def school_headers(session, platform, user_agent):
    return {
        'Accept': 'application/json', 'platform': platform,
        'Cookie': f'SESSION={session}', 'Origin': ORIGIN,
        'Referer': ORIGIN + '/daily-checkin-h5/index.html?appId=294',
        'User-Agent': user_agent,
    }


def validate_session(session):
    if not isinstance(session, str) or not SESSION_RE.match(session):
        raise FlowError('SCHOOL_SESSION_REQUIRED')
    return session


def validate_location(location):
    if not isinstance(location, dict):
        raise FlowError('LOCATION_INVALID')
    if location.get('coordinateSystemCode', 'gcj02') != 'gcj02':
        raise FlowError('COORDINATE_SYSTEM_INVALID')
    latitude, longitude = location.get('latitude'), location.get('longitude')
    if type(latitude) not in (int, float) or type(longitude) not in (int, float):
        raise FlowError('COORDINATES_INVALID')
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise FlowError('COORDINATES_INVALID')
    if abs(latitude) > 90 or abs(longitude) > 180:
        raise FlowError('COORDINATES_INVALID')
    return {'latitude': latitude, 'longitude': longitude, 'coordinateSystemCode': 'gcj02'}


def distance_meters(a, b):
    rad = math.radians
    dlat = rad(b['latitude'] - a['latitude'])
    dlng = rad(b['longitude'] - a['longitude'])
    h = math.sin(dlat / 2) ** 2 + math.cos(rad(a['latitude'])) * math.cos(rad(b['latitude'])) * math.sin(dlng / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, h)))


def extract_address(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ('address', 'reverseGeocode', 'formattedAddress'):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    return ''


class Ledger:
    """One claim per school day; a failed POST is never silently repeated."""

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._session() as db:
            db.execute('CREATE TABLE IF NOT EXISTS attempts (day TEXT PRIMARY KEY, stage TEXT NOT NULL, time TEXT NOT NULL)')

    @contextmanager
    def _session(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def exists(self, day):
        with self._session() as db:
            return db.execute('SELECT 1 FROM attempts WHERE day = ?', (day,)).fetchone() is not None

    def claim(self, day, time_text):
        with self._session() as db:
            try:
                db.execute('INSERT INTO attempts VALUES (?, ?, ?)', (day, 'sending', time_text))
            except sqlite3.IntegrityError:
                raise FlowError('ATTEMPT_ALREADY_RECORDED') from None

    def finish(self, day, stage, time_text):
        with self._session() as db:
            db.execute('UPDATE attempts SET stage = ?, time = ? WHERE day = ?', (stage, time_text, day))


def run_checkin(config, code_provider, *, http=default_http, submit=False, now=china_now, sleep=time.sleep):
    session = validate_session(config.get('session'))
    location = validate_location(config.get('location'))
    user_agent = str(config.get('userAgent') or 'UESTC-NightSign-Server/1.0')
    if any(c in user_agent for c in '\r\n'):
        raise FlowError('USER_AGENT_INVALID')
    ledger = Ledger(config['ledger']) if submit else None
    headers = school_headers(session, 'h5', user_agent)
    day = now().date().isoformat()
    today = call(http, API + 'student-checkin-record/today', headers)
    if not isinstance(today, dict) or today.get('businessDate') != day or not isinstance(today.get('recordStatusCode'), str):
        raise FlowError('TODAY_RESPONSE_INVALID')
    if today['recordStatusCode'] in CLOSED_RECORD:
        return {'ok': True, 'stage': 'already_checked_in', 'businessDate': day}
    if submit and ledger.exists(day):
        raise FlowError('ATTEMPT_ALREADY_RECORDED')
    schedule = call(http, API + 'checkin-schedule/effective', headers)
    if not isinstance(schedule, dict):
        raise FlowError('SCHEDULE_INVALID')
    start = schedule.get('studentCheckinStartOffsetMinute')
    end = schedule.get('studentCheckinEndOffsetMinute')
    if schedule.get('effective') is not True or type(start) is not int or type(end) is not int or not 0 <= start <= end <= 1439:
        raise FlowError('SCHEDULE_INVALID')
    minute = now().hour * 60 + now().minute
    if submit and not start <= minute <= end:
        raise FlowError('OUTSIDE_CHECKIN_WINDOW')
    locations = call(http, API + 'checkin-location/available-locations', headers)
    if not isinstance(locations, list):
        raise FlowError('LOCATIONS_INVALID')
    inside = any(
        isinstance(item, dict)
        and type(item.get('latitude')) in (int, float)
        and type(item.get('longitude')) in (int, float)
        and type(item.get('radiusMeter')) in (int, float) and item['radiusMeter'] > 0
        and distance_meters(location, item) <= item['radiusMeter']
        for item in locations
    )
    if not inside:
        raise FlowError('OUTSIDE_ALLOWED_LOCATION')
    address_data = call(http, API + f"map/reverse?lat={location['latitude']}&lng={location['longitude']}", headers)
    address = extract_address(address_data)
    if not address:
        raise FlowError('ADDRESS_MISSING')
    code = code_provider()
    if not isinstance(code, str) or not CODE_RE.match(code):
        raise FlowError('CODE_INVALID')
    ticket_data = call(http, TICKET_PATH, school_headers(session, 'mp-weixin', user_agent), {'code': code})
    ticket = ticket_data if isinstance(ticket_data, str) else (ticket_data or {}).get('ticket')
    if not isinstance(ticket, str) or not TICKET_RE.match(ticket):
        raise FlowError('TICKET_INVALID')
    if not submit:
        return {'ok': True, 'stage': 'authorization_verified', 'businessDate': day,
                'insideFence': True, 'startMinute': start, 'endMinute': end,
                'codeLength': len(code), 'ticketLength': len(ticket), 'checkinSubmitted': False}

    moment = now()
    if moment.date().isoformat() != day or not start <= moment.hour * 60 + moment.minute <= end:
        raise FlowError('CHECKIN_WINDOW_CHANGED')
    payload = {
        'latitude': location['latitude'], 'longitude': location['longitude'],
        'reverseGeocode': address, 'clientTime': moment.strftime('%Y-%m-%d %H:%M:%S'),
        'userAgent': user_agent, 'coordinateSystemCode': 'gcj02',
        'accuracy': 0, 'locationDurationMs': 0, 'networkTypeCode': 'unknown',
        'locationEnabled': False, 'locationAuthorized': '', 'locationAccuracy': '',
        'errorMessage': 'configured coordinate; no live positioning',
    }
    ledger.claim(day, moment.isoformat(timespec='seconds'))
    accepted, rejected = False, None
    try:
        call(http, SUBMIT_PATH, dict(headers, **{'X-Checkin-Ticket': ticket}), payload)
        accepted = True
    except FlowError as error:
        rejected = error.code
    confirmed = False
    for attempt in range(3):
        if attempt:
            sleep(2)
        try:
            after = call(http, API + 'student-checkin-record/today', headers)
            confirmed = isinstance(after, dict) and after.get('businessDate') == day and after.get('recordStatusCode') == 'CHECKED_IN'
            if confirmed:
                break
        except FlowError:
            continue
    stage = 'checked_in_confirmed' if confirmed else ('accepted_unconfirmed' if accepted else 'result_unknown')
    ledger.finish(day, stage, moment.isoformat(timespec='seconds'))
    result = {'ok': confirmed, 'stage': stage, 'businessDate': day, 'postAccepted': accepted, 'checkinSubmitted': True}
    if rejected:
        result['rejectedCode'] = rejected
    return result


def acquire_lock(path):
    try:
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise FlowError('JOB_ALREADY_RUNNING_OR_STALE_LOCK') from None


def run_cli(argv, outcome=None):
    parser = argparse.ArgumentParser(description="One-shot check-in using a replayed code and the user's own school session.")
    parser.add_argument('--config', type=Path, required=True, help='private JSON config')
    parser.add_argument('--verify', action='store_true', help='only verify authorization (default)')
    parser.add_argument('--submit', action='store_true', help='send exactly one check-in request')
    parser.add_argument('--timeout', type=float, default=20)
    args = parser.parse_args(argv)
    if args.verify == args.submit:
        parser.error('choose exactly one of --verify or --submit')
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be finite and positive')
    root = args.config.resolve().parent
    config = json.loads(args.config.read_text(encoding='utf-8'))
    state_path = Path(config.get('state') or 'login-state.json')
    if not state_path.is_absolute():
        state_path = root / state_path
    config['ledger'] = str(root / config.get('ledger', 'data/attempts.sqlite'))
    state = load_state(state_path)
    code_provider = lambda: request_code(state, timeout=args.timeout, attempts=2)
    lock_path = root / 'checkin.lock'
    lock = acquire_lock(lock_path)
    try:
        result = run_checkin(config, code_provider, submit=args.submit)
        if outcome is not None:
            outcome.update(result)
    finally:
        os.close(lock)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
    print(json.dumps(result))
    return 0 if result['ok'] else 1


def _main(argv=None, outcome=None):
    try:
        return run_cli(sys.argv[1:] if argv is None else argv, outcome)
    except FlowError as error:
        print(json.dumps({'ok': False, 'error': error.code}), file=sys.stderr)
        return 1
    except ValueError as error:
        detail = str(error)
        code = detail if re.fullmatch(r'[A-Z][A-Z0-9_]+', detail) else 'JOB_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'error': 'JOB_FAILED'}), file=sys.stderr)
        return 1


def main(argv=None):
    values = sys.argv[1:] if argv is None else list(argv)
    result = {'ok': False}
    try:
        return _main(values, result)
    finally:
        if '--submit' in values and '--verify' not in values and '--config' in values:
            index = values.index('--config') + 1
            if index < len(values):
                path = Path(values[index]).resolve().parent / 'notify.json'
                print(json.dumps(send_notification(result, path)))


if __name__ == '__main__':
    sys.exit(main())
