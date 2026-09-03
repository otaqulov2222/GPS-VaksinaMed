"""Vercel production entrypoint — barcha so'rovlar vm_server orqali."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import Response

app = FastAPI()


def _client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").strip()
    if fwd:
        return fwd.split(",")[0].strip()
    return request.headers.get("x-real-ip") or "127.0.0.1"


def _cron_authorized(request: Request) -> bool:
    secret = (os.environ.get("CRON_SECRET") or "").strip()
    auth = (request.headers.get("authorization") or "").strip()
    return bool(secret) and auth == f"Bearer {secret}"


@app.api_route("/", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
@app.api_route("/{full_path:path}", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
async def handle(request: Request, full_path: str = ""):
    path = request.url.path or "/"

    # Yengil health — vm_server / Neon OLMASDAN (25s 504 ni to'xtatadi)
    if path == "/api/health" and request.method in ("GET", "HEAD", "OPTIONS"):
        if request.method == "OPTIONS":
            return Response(status_code=204)
        body = json.dumps(
            {
                "ok": True,
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "lite": True,
            }
        ).encode("utf-8")
        if request.method == "HEAD":
            return Response(status_code=200, media_type="application/json")
        return Response(content=body, status_code=200, media_type="application/json")

    # Cron: darhol 202 — og'ir sync Vercel Fluid 25s da sig'maydi.
    # Haqiqiy sync: GitHub Actions (scripts/run_gps_cron.py).
    if path == "/api/cron/gps-sync" and request.method in ("GET", "POST", "HEAD"):
        if not _cron_authorized(request):
            return Response(
                content=b'{"ok":false,"error":"Unauthorized"}',
                status_code=401,
                media_type="application/json",
            )
        if request.method == "HEAD":
            return Response(status_code=202, media_type="application/json")
        payload = {
            "ok": True,
            "accepted": True,
            "message": "GPS sync GitHub Actions orqali bajariladi (Vercel 25s limiti).",
        }
        return Response(
            content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            status_code=202,
            media_type="application/json",
        )

    from vm_server import dispatch_http

    body = await request.body()
    dispatch_path = path
    if request.url.query:
        dispatch_path += "?" + str(request.url.query)
    status, out_headers, out_body = dispatch_http(
        request.method,
        dispatch_path,
        dict(request.headers),
        body,
        _client_ip(request),
    )
    skip = {"transfer-encoding", "connection", "content-length", "content-encoding"}
    headers = {k: v for k, v in out_headers.items() if k.lower() not in skip}
    media_type = headers.pop("Content-Type", None) or headers.pop("content-type", None)
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type=media_type)
    return Response(content=out_body, status_code=status, headers=headers, media_type=media_type)
