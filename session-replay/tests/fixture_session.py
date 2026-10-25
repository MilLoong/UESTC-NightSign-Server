"""Synthetic MMTLS fixture; no captured account data."""
import base64
import hashlib
import json
import zlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from login_replay.state import APP_ID
from login_replay.protocol import hkdf_expand


COOKIE = "SESSION=fixture_session_1234567890"
CODE = "0" + "A" * 31
TICKET = "T" * 43


def record(kind, payload):
    return bytes([kind]) + b"\xf1\x04" + len(payload).to_bytes(2, "big") + payload


def encrypted_record(kind, payload, sequence, key_iv):
    header = bytes([kind]) + b"\xf1\x04" + (len(payload) + 16).to_bytes(2, "big")
    counter = sequence.to_bytes(8, "big")
    nonce = bytes(a ^ b for a, b in zip(key_iv[16:], b"\0" * 4 + counter))
    return header + AESGCM(key_iv[:16]).encrypt(nonce, payload, counter + header)


def make_state():
    secret = bytes(range(32))
    hello, extensions, server = b"fixture client hello", b"fixture extensions", b"fixture server hello"
    early = hkdf_expand(secret, b"early data key expansion" + hashlib.sha256(hello).digest(), 28)
    request_body = b"".join([
        record(25, hello), encrypted_record(25, extensions, 1, early),
        encrypted_record(23, b"fixture request", 2, early),
        encrypted_record(21, b"fixture alert", 3, early),
    ])
    request = (
        "POST /mmtls/00000001 HTTP/1.1\r\nHost: szextshort.weixin.qq.com\r\n"
        f"Content-Length: {len(request_body)}\r\n\r\n"
    ).encode() + request_body
    business_key, business_nonce = bytes(range(24)), bytes(range(12))
    decoded = b"\x0a\x02\x08\x00\x1a\x20" + CODE.encode()
    encrypted = AESGCM(business_key).encrypt(business_nonce, zlib.compress(decoded), b"")
    packet = b"\xbf\x08" + encrypted[:-16] + business_nonce + encrypted[-16:]
    response_key = hkdf_expand(
        secret, b"handshake key expansion" + hashlib.sha256(hello + extensions + server).digest(), 28,
    )
    response_body = b"".join([
        record(22, server), encrypted_record(22, b"fixture finished", 1, response_key),
        encrypted_record(23, packet, 2, response_key),
        encrypted_record(21, b"fixture alert", 3, response_key),
    ])
    response = (
        f"HTTP/1.1 200 OK\r\nContent-Length: {len(response_body)}\r\n\r\n"
    ).encode() + response_body
    encode = lambda value: base64.b64encode(value).decode()
    return {
        "version": 1, "appId": APP_ID, "httpRequest": encode(request),
        "capturedHttpResponse": encode(response), "mmtlsSecret": encode(secret),
        "businessResponseKey": encode(business_key), "businessResponseAad": "",
        "capturedCodeHash": hashlib.sha256(CODE.encode()).hexdigest(),
    }


def encoded_state():
    return base64.b64encode(json.dumps(make_state()).encode()).decode()
