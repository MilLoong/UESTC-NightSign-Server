"""Export the SESSION cookie from the user's open UESTC check-in page (Windows)."""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from .detect import select_host

SESSION_PATTERN = re.compile(r'[A-Za-z0-9._~%-]{16,512}', re.ASCII)
SESSION_AGENT = r"""
'use strict';

rpc.exports.read = function () {
  const sessions = new Set();
  const marker = 'https://jzsz.uestc.edu.cn/';
  const pattern = Array.from(marker, c => c.charCodeAt(0).toString(16)).join(' ');
  const ranges = Process.enumerateRanges({protection: 'rw-', coalesce: true})
    .filter(r => !r.file && r.size <= 134217728);
  for (const range of ranges) {
    try {
      for (const match of Memory.scanSync(range.base, range.size, pattern)) {
        const available = range.base.add(range.size).sub(match.address).toUInt32();
        const bytes = new Uint8Array(match.address.readByteArray(Math.min(1024, available)));
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        const url = text.match(/^https:\/\/jzsz\.uestc\.edu\.cn\/daily-checkin-h5(?:-test)?\/index\.html\?([^\x00\s"<>]+)/);
        if (!url) continue;
        const query = url[1].split('#')[0];
        const session = query.match(/(?:^|&)sessionId=([A-Za-z0-9._~%-]{16,512})(?:&|$)/);
        const ticket = query.match(/(?:^|&)checkinTicket=[A-Za-z0-9_-]{43}(?:&|$)/);
        if (session && ticket) sessions.add(decodeURIComponent(session[1]));
      }
    } catch (_) {}
  }
  return Array.from(sessions);
};
"""


def positive_pid(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError('PID must be positive.')
    return number


def read_sessions(network_pid):
    try:
        import frida
    except ImportError:
        raise RuntimeError('CAPTURE_REQUIRES_FRIDA') from None
    session = frida.attach(network_pid)
    try:
        script = session.create_script(SESSION_AGENT)
        script.load()
        return script.exports_sync.read()
    finally:
        session.detach()


def make_cookie(sessions):
    if not isinstance(sessions, list):
        raise ValueError('CAPTURE_SESSION_RESULT_INVALID')
    if any(not isinstance(value, str) for value in sessions):
        raise ValueError('CAPTURE_SESSION_RESULT_INVALID')
    values = set(sessions)
    if not values:
        raise RuntimeError('OPEN_CHECKIN_PAGE_FIRST')
    if len(values) != 1:
        raise RuntimeError('CAPTURE_SESSION_AMBIGUOUS')
    value = next(iter(values))
    if SESSION_PATTERN.fullmatch(value) is None:
        raise ValueError('CAPTURE_SESSION_INVALID')
    return 'SESSION=' + value


def save_cookie(path, cookie):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', newline='\n', dir=path.parent,
            prefix=path.name + '.', suffix='.tmp', delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(cookie + '\n')
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--pid', type=positive_pid, help='ILinkServiceHost PID')
    selection.add_argument('--host-pid', type=positive_pid, help='network-owning parent PID')
    parser.add_argument('--output', type=Path, required=True, help='write SESSION=<value> here')
    args = parser.parse_args(argv)
    try:
        login_pid, network_pid = select_host(args.pid, args.host_pid)
        cookie = make_cookie(read_sessions(network_pid))
        save_cookie(args.output, cookie)
        print(json.dumps({
            'ok': True, 'savedTo': str(args.output), 'loginPid': login_pid,
            'networkPid': network_pid, 'cookieName': 'SESSION',
            'cookieLength': len(cookie), 'networkRequests': 0, 'validityChecked': False,
        }))
        return 0
    except RuntimeError as error:
        message = str(error)
        code = message.split(':')[0].split(' ')[0]
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', code):
            code = 'CAPTURE_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        return 1
    except (ValueError, OSError) as error:
        message = str(error).split(':')[0]
        code = message if re.fullmatch(r'[A-Z][A-Z0-9_]*', message) else 'CAPTURE_FAILED'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
