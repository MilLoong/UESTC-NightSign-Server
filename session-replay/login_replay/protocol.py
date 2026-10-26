"""MMTLS decoding derived from an MIT-licensed reference implementation.

See LICENSE.upstream for the retained copyright and permission notice.
"""
import base64
import hashlib
import hmac
import re
import zlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HOST = "szextshort.weixin.qq.com"

def hkdf_expand(secret, info, size):
    output = b''
    block = b''
    counter = 1
    while len(output) < size:
        block = hmac.new(secret, block + info + bytes([counter]), hashlib.sha256).digest()
        output += block
        counter += 1
    return output[:size]


def records(body):
    output = []
    offset = 0
    while offset < len(body):
        if offset + 5 > len(body):
            raise ValueError('Truncated MMTLS record header')
        header = body[offset:offset + 5]
        end = offset + 5 + int.from_bytes(header[3:5], 'big')
        if end > len(body) or header[1:3] != b'\xf1\x04':
            raise ValueError('Unexpected or truncated MMTLS record')
        output.append((header, body[offset + 5:end]))
        offset = end
    return output


def decrypt_record(key_iv, sequence, header, data):
    key, iv = key_iv[:16], key_iv[16:]
    counter = sequence.to_bytes(8, 'big')
    nonce = bytes(x ^ y for x, y in zip(iv, b'\0' * 4 + counter))
    return AESGCM(key).decrypt(nonce, data, counter + header)


def parse_request(raw):
    header, separator, body = raw.partition(b'\r\n\r\n')
    if not separator:
        raise ValueError('Missing captured HTTP headers')
    lines = header.decode('ascii').split('\r\n')
    method, path, version = lines[0].split(' ')
    headers = dict(line.split(': ', 1) for line in lines[1:])
    if method != 'POST' or version != 'HTTP/1.1' or headers.get('Host') != HOST:
        raise ValueError('Unexpected captured login destination')
    if not re.fullmatch(r'/mmtls/[a-fA-F0-9]{8}', path):
        raise ValueError('Unexpected captured MMTLS path')
    if int(headers.get('Content-Length', '-1')) != len(body):
        raise ValueError('Captured HTTP request is incomplete')
    return path, headers, body


def session_inputs(state, request_body):
    request_records = records(request_body)
    if len(request_records) != 4:
        raise ValueError('Expected four short-link request records')
    hello = request_records[0][1]
    secret = base64.b64decode(state['mmtlsSecret'], validate=True)
    if len(secret) != 32:
        raise ValueError('Invalid captured MMTLS secret')
    early = hkdf_expand(secret, b'early data key expansion' + hashlib.sha256(hello).digest(), 28)
    header, data = request_records[1]
    extensions = decrypt_record(early, 1, header, data)
    return secret, hello, extensions


def unwrap_business(state, response_body, inputs):
    secret, client_hello, extensions = inputs
    response_records = records(response_body)
    if len(response_records) != 4 or response_records[0][0][0] != 22:
        raise ValueError('Unexpected MMTLS response; the captured session may require refreshing')
    server_hello = response_records[0][1]
    transcript = hashlib.sha256(client_hello + extensions + server_hello).digest()
    key_iv = hkdf_expand(secret, b'handshake key expansion' + transcript, 28)
    plaintext = [
        (header[0], decrypt_record(key_iv, index, header, data))
        for index, (header, data) in enumerate(response_records[1:], 1)
    ]
    messages = [value for kind, value in plaintext if kind == 23]
    if len(messages) != 1:
        raise ValueError('Expected one authenticated business response')
    packet = messages[0]
    if len(packet) < 3 or packet[0] != 0xbf:
        raise ValueError('Unexpected WeChat business packet')
    header_length = packet[1] >> 2
    encrypted = packet[header_length:]
    if len(encrypted) < 28:
        raise ValueError('Truncated business GCM packet')
    key = base64.b64decode(state['businessResponseKey'], validate=True)
    aad = base64.b64decode(state['businessResponseAad'], validate=True)
    compressed = AESGCM(key).decrypt(
        encrypted[-28:-16], encrypted[:-28] + encrypted[-16:], aad)
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(compressed, 1024 * 1024 + 1)
    if len(decoded) > 1024 * 1024 or not inflater.eof:
        raise ValueError('Incomplete or oversized compressed login response')
    return decoded


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            break
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError('Malformed Protobuf integer')


def protobuf_fields(data):
    result = []
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        if not field:
            raise ValueError('Invalid Protobuf field')
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire == 2:
            size, offset = varint(data, offset)
            value = data[offset:offset + size]
            offset += size
            if len(value) != size:
                raise ValueError('Truncated Protobuf field')
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value = data[offset:offset + size]
            offset += size
            if len(value) != size:
                raise ValueError('Truncated fixed-width Protobuf field')
        else:
            raise ValueError('Unsupported Protobuf wire type')
        result.append((field, wire, value))
    return result


def extract_code(decoded):
    fields = protobuf_fields(decoded)
    base = next((value for field, wire, value in fields if field == 1 and wire == 2), None)
    if base is None:
        raise ValueError('Missing business BaseResponse')
    returns = [value for field, wire, value in protobuf_fields(base) if field == 1 and wire == 0]
    if returns != [0]:
        raise ValueError(f'Business BaseResponse rejected the request: {returns}')
    # The nested transport frame is proprietary. Restrict extraction to the
    # observed JsLoginResponse field 3, 32-byte code, and require uniqueness.
    candidates = set(re.findall(rb'\x1a\x20(0[A-Za-z0-9_-]{31})', decoded))
    if len(candidates) != 1:
        raise ValueError(f'Expected one login code field, found {len(candidates)}')
    return candidates.pop().decode('ascii')
