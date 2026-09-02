"""
Vercel serverless — barcha /api/* va /gps-proxy so'rovlarini server.py ga uzatadi.
Lokal ish: python server.py (o'zgarmaydi).
"""
from __future__ import annotations

import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlencode, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _client_ip(headers) -> str:
    fwd = (headers.get("X-Forwarded-For") or headers.get("x-forwarded-for") or "").strip()
    if fwd:
        return fwd.split(",")[0].strip()
    return headers.get("X-Real-Ip") or headers.get("x-real-ip") or "127.0.0.1"


def _resolve_path(raw_path: str) -> str:
    parsed = urlparse(raw_path)
    qs = parse_qs(parsed.query, keep_blank_values=True)
    sub = (qs.pop("path", [""])[0] or "").strip()
    if sub:
        route = "/gps-proxy" if sub == "gps-proxy" else "/api/" + sub
    else:
        route = parsed.path or "/"
    extra = []
    for key, vals in qs.items():
        for val in vals:
            extra.append((key, val))
    if extra:
        route += "?" + urlencode(extra)
    return route


def _dispatch(method: str, raw_path: str, headers, body: bytes):
    from server import dispatch_http

    route_path = _resolve_path(raw_path)
    return dispatch_http(method, route_path, headers, body, _client_ip(headers))


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _run(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""
        headers = {k: self.headers[k] for k in self.headers}
        status, out_headers, out_body = _dispatch(self.command, self.path, headers, body)
        self.send_response(status)
        for key, val in out_headers.items():
            self.send_header(key, val)
        if "Content-Length" not in out_headers and "content-length" not in {k.lower() for k in out_headers}:
            self.send_header("Content-Length", str(len(out_body)))
        self.end_headers()
        if self.command != "HEAD" and out_body:
            self.wfile.write(out_body)

    def do_GET(self):
        self._run()

    def do_POST(self):
        self._run()

    def do_OPTIONS(self):
        self._run()

    def do_HEAD(self):
        self._run()
