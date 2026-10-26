"""One-shot Windows capture: trigger a login, trace it, then build the state."""
import argparse
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

from .build_state import build_state, write_state
from .detect import select_host

AGENTS = Path(__file__).resolve().parent / 'agents'


def _read_agent(name):
    return (AGENTS / name).read_text(encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Capture one WeChat mini-program login on Windows and write a replay state.')
    parser.add_argument('--output', type=Path, required=True, help='state file to create')
    parser.add_argument('--pid', type=int, help='ILinkServiceHost PID (auto-detected when unique)')
    parser.add_argument('--host-pid', type=int, help='network-owning parent PID')
    parser.add_argument('--timeout', type=float, default=60, help='wait for the login to complete')
    parser.add_argument('--force', action='store_true', help='replace an existing state file')
    parser.add_argument('--keep-trace', type=Path, help='keep the raw trace for debugging (contains secrets)')
    args = parser.parse_args(argv)
    try:
        if args.output.exists() and not args.force:
            raise ValueError('STATE_EXISTS_USE_FORCE')
        if not (10 <= args.timeout <= 300):
            raise ValueError('CAPTURE_TIMEOUT_INVALID')
        login_pid, network_pid = select_host(args.pid, args.host_pid)
        try:
            import frida
        except ImportError:
            raise RuntimeError('CAPTURE_REQUIRES_FRIDA') from None
        events = []
        binaries = {}
        code_seen = threading.Event()
        idle = threading.Event()
        guard = threading.Lock()

        def on_message(prefix):
            def handler(message, data):
                payload = message.get('payload') or message
                if not isinstance(payload, dict):
                    payload = {'event': 'raw', 'detail': str(payload)}
                event = payload.get('event') or message.get('type') or 'raw'
                with guard:
                    if data is not None:
                        name = f'{len(events):03d}-{event}.bin'
                        binaries[name] = bytes(data)
                        payload = dict(payload, binaryFile=name)
                    events.append(dict(payload, source=prefix))
                if event == 'active.login-code':
                    code_seen.set()
                if event == 'active.idle':
                    idle.set()
            return handler

        host = frida.attach(login_pid)
        network = frida.attach(network_pid)
        try:
            tracer = host.create_script(_read_agent('trace_login.js'))
            tracer.on('message', on_message('host'))
            tracer.load()
            wire = network.create_script(_read_agent('trace_wire.js'))
            wire.on('message', on_message('network'))
            wire.load()
            wire.exports_sync.enable(True)
            login = host.create_script(_read_agent('active_login.js'))
            login.on('message', on_message('host'))
            login.load()
            login.exports_sync.trigger(False)
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline and not (code_seen.is_set() and idle.is_set()):
                time.sleep(0.05)
            if not code_seen.is_set():
                raise RuntimeError('CAPTURE_CODE_TIMEOUT')
            time.sleep(0.3)  # let trailing wire messages arrive
            tracer.exports_sync.finish()
            wire.exports_sync.enable(False)
        finally:
            try:
                host.detach()
            finally:
                network.detach()
        state = build_state(events, binaries.__getitem__)
        write_state(state, args.output, args.force)
        if args.keep_trace:
            root = args.keep_trace
            root.mkdir(parents=True, exist_ok=True)
            os.chmod(root, 0o700)
            for name, blob in binaries.items():
                target = root / name
                target.write_bytes(blob)
                os.chmod(target, 0o600)
            notes = root / 'events.json'
            notes.write_text(json.dumps(events, indent=2), encoding='utf-8')
            os.chmod(notes, 0o600)
        print(json.dumps({
            'ok': True, 'appId': state['appId'], 'stateFile': str(args.output),
            'loginPid': login_pid, 'networkPid': network_pid,
            'capturedCodeHash': state['capturedCodeHash'][:16],
        }))
        return 0
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error).split(':')[0]}), file=sys.stderr)
        return 1
    except RuntimeError as error:
        message = str(error)
        code = message.split(':')[0].split(' ')[0]
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', code):
            code = 'CAPTURE_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        return 1
    except Exception as error:
        message = str(error)
        if 'Unsupported' in message or 'version mismatch' in message:
            code = 'CAPTURE_UNSUPPORTED_WECHAT_BUILD'
        elif 'attach' in message.lower() or 'permission' in message.lower():
            code = 'CAPTURE_ATTACH_FAILED'
        else:
            code = 'CAPTURE_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
