"""Fixed-destination transport; no redirects, only bounded connection retries."""
import base64
import http.client
import time

from .protocol import HOST, parse_request, session_inputs, unwrap_business, extract_code


def request_code(state, timeout=20, attempts=1, backoff=2.0):
    """Replay the captured request once, retrying only connection-level errors.

    Each replay mints a fresh code, so retrying is safe; protocol or HTTP
    rejections are not retried and mean the captured state needs refreshing.
    """
    attempts = max(1, int(attempts))
    last = None
    for attempt in range(attempts):
        try:
            return _request_once(state, timeout)
        except (OSError, http.client.HTTPException) as error:
            last = error
            if attempt + 1 < attempts:
                time.sleep(backoff * (attempt + 1))
    raise last


def _request_once(state, timeout):
    raw = base64.b64decode(state["httpRequest"], validate=True)
    path, headers, body = parse_request(raw)
    inputs = session_inputs(state, body)
    connection = http.client.HTTPConnection(HOST, 80, timeout=timeout)
    try:
        connection.putrequest("POST", path, skip_host=True, skip_accept_encoding=True)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders(body)
        response = connection.getresponse()
        received = response.read(262145)
        if response.status != 200 or len(received) > 262144:
            raise ValueError("LOGIN_HTTP_FAILED")
    finally:
        connection.close()
    return extract_code(unwrap_business(state, received, inputs))
