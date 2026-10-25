"""Fixed-destination transport; no redirects or automatic retries."""
import base64
import http.client
from .protocol import HOST, parse_request, session_inputs, unwrap_business, extract_code


def request_code(state, timeout=20):
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
