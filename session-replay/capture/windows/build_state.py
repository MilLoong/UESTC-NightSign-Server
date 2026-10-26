"""Build a replay state from a captured Windows trace, then validate it offline."""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from login_replay.protocol import extract_code, parse_request, session_inputs, unwrap_business
from login_replay.state import APP_ID, load_state

CODE_RE = re.compile(r'^[A-Za-z0-9_-]{24,128}$')
MAX_BINARY = 512 * 1024


def _one(events, name):
    found = [event for event in events if event.get('event') == name]
    if len(found) != 1:
        raise ValueError(f'CAPTURE_EXPECTED_ONE_{name}:{len(found)}')
    return found[0]


def _hex(value, code):
    if not isinstance(value, str) or not value or len(value) > 2 * MAX_BINARY:
        raise ValueError(code)
    try:
        return bytes.fromhex(value)
    except ValueError:
        raise ValueError(code) from None


def build_state(events, read_binary, app_id=APP_ID):
    """Combine trace events into a validated version=1 state.

    ``read_binary`` maps a trace event's ``binaryFile`` to its bytes.
    Every candidate request/response pair is tried so unrelated sockets in the
    trace cannot corrupt the state; only a pair that decrypts to the same code
    as the native callback is accepted.
    """
    login = _one(events, 'active.login-code').get('detail') or {}
    code = login.get('code')
    if not isinstance(code, str) or not CODE_RE.match(code):
        raise ValueError('CAPTURE_CODE_INVALID')
    if login.get('appId') != app_id:
        raise ValueError('CAPTURE_APP_MISMATCH')

    expands = [event.get('detail') or {} for event in events if event.get('event') == 'trace.mmtls-expand']
    secrets = {detail.get('secretHex') for detail in expands if detail.get('secretHex')}
    if len(secrets) != 1:
        raise ValueError('CAPTURE_SECRET_AMBIGUOUS')
    secret = _hex(next(iter(secrets)), 'CAPTURE_SECRET_INVALID')

    inner = _one(events, 'trace.mmtls-inner-gcm').get('detail') or {}
    key = _hex(inner.get('keyHex'), 'CAPTURE_BUSINESS_KEY_INVALID')
    aad = _hex(inner.get('aadHex') or '', 'CAPTURE_BUSINESS_AAD_INVALID') if inner.get('aadHex') else b''
    if not 16 <= len(key) <= 32:
        raise ValueError('CAPTURE_BUSINESS_KEY_INVALID')
    if len(aad) > 4096:
        raise ValueError('CAPTURE_BUSINESS_AAD_INVALID')

    sends = [event for event in events if event.get('event') == 'trace.main-send' and event.get('binaryFile')]
    receives = [event for event in events if event.get('event') == 'trace.main-recv' and event.get('binaryFile')]
    if not sends or not receives:
        raise ValueError('CAPTURE_WIRE_MISSING')

    for send in sends:
        try:
            request = read_binary(send['binaryFile'])
        except (OSError, KeyError, TypeError):
            continue
        if not 0 < len(request) <= MAX_BINARY:
            continue
        for receive in receives:
            try:
                response = read_binary(receive['binaryFile'])
            except (OSError, KeyError, TypeError):
                continue
            if not 0 < len(response) <= MAX_BINARY:
                continue
            state = {
                'version': 1, 'appId': app_id,
                'preparedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'mode': 'replay of an authenticated session; requires refresh on expiry',
                'httpRequest': base64.b64encode(request).decode('ascii'),
                'capturedHttpResponse': base64.b64encode(response).decode('ascii'),
                'mmtlsSecret': base64.b64encode(secret).decode('ascii'),
                'businessResponseKey': base64.b64encode(key).decode('ascii'),
                'businessResponseAad': base64.b64encode(aad).decode('ascii'),
                'capturedCodeHash': hashlib.sha256(code.encode()).hexdigest(),
            }
            try:
                body = parse_request(request)[2]
                decoded = extract_code(unwrap_business(state, response.partition(b'\r\n\r\n')[2], session_inputs(state, body)))
            except Exception:
                continue
            if decoded == code:
                return state
    raise ValueError('CAPTURE_INCONSISTENT_WITH_NATIVE_CODE')


def load_trace(directory, max_events=5000):
    root = Path(directory)
    events = json.loads((root / 'events.json').read_text(encoding='utf-8'))
    if not isinstance(events, list) or not events or len(events) > max_events:
        raise ValueError('CAPTURE_TRACE_INVALID')
    cache = {}

    def read_binary(name):
        if name not in cache:
            path = root / name
            if path.suffix != '.bin':
                raise ValueError('CAPTURE_BINARY_NAME_INVALID')
            cache[name] = path.read_bytes()
        return cache[name]

    return events, read_binary


def write_state(state, path, force=False):
    """Write the state atomically with owner-only permissions."""
    path = Path(path)
    if path.exists() and not force:
        raise ValueError('STATE_EXISTS_USE_FORCE')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build and validate a replay state from a captured trace.')
    parser.add_argument('--trace', type=Path, help='trace directory containing events.json and *.bin')
    parser.add_argument('--output', type=Path, help='write state here')
    parser.add_argument('--force', action='store_true', help='replace an existing state file')
    parser.add_argument('--check', type=Path, help='validate an existing state file only')
    args = parser.parse_args(argv)
    try:
        if args.check:
            state = load_state(args.check)
            print(json.dumps({'ok': True, 'appId': state['appId'], 'preparedAt': state.get('preparedAt')}))
            return 0
        if not args.trace or not args.output:
            parser.error('--trace and --output are required unless --check is used')
        events, read_binary = load_trace(args.trace)
        state = build_state(events, read_binary)
        write_state(state, args.output, args.force)
        print(json.dumps({
            'ok': True, 'appId': state['appId'], 'stateFile': str(args.output),
            'capturedCodeHash': state['capturedCodeHash'][:16],
        }))
        return 0
    except ValueError as error:
        detail = str(error)
        print(json.dumps({'ok': False, 'error': detail.split(':')[0]}), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps({'ok': False, 'error': 'CAPTURE_IO_FAILED'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
