"""Offline by default. Explicit --online performs exactly one login request."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from .state import load_state, APP_ID
from .transport import request_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--online", action="store_true")
    parser.add_argument("--ledger", type=Path, default=Path("/data/codes.sqlite"))
    parser.add_argument("--code-file", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        state = load_state(args.state)
        if not args.online:
            print(json.dumps({"ok": True, "mode": "offline", "appId": APP_ID}))
            return 0
        with closing(sqlite3.connect(args.ledger, timeout=1)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS seen (hash TEXT PRIMARY KEY)")
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            code = request_code(state)
            digest = hashlib.sha256(code.encode()).hexdigest()
            if digest == state["capturedCodeHash"]:
                raise ValueError("CAPTURED_CODE_REPEATED")
            if db.execute("SELECT 1 FROM seen WHERE hash = ?", (digest,)).fetchone():
                raise ValueError("LOGIN_CODE_REPEATED")
            db.execute("INSERT INTO seen VALUES (?)", (digest,))
        if args.code_file:
            fd = os.open(args.code_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as output:
                output.write(code)
        print(json.dumps({"ok": True, "mode": "online", "appId": APP_ID,
                          "codeLength": len(code), "codeSaved": bool(args.code_file)}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
