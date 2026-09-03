"""Vercel production entrypoint — barcha so'rovlar vm_server orqali."""
from __future__ import annotations

import asyncio
import json
import os

from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

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


def _run_gps_cron():
    """Fon sync — streaming birinchi baytdan keyin ishlaydi (25s limit yechimi)."""
    from vm_server import DIRECTORY, OFFICE, _gps_sync_lock, init_app
    import gps_sync

    init_app()
    d = gps_sync.today_tashkent()
    with _gps_sync_lock:
        result = (
            gps_sync.sync_today(
                OFFICE,
                DIRECTORY,
                d,
                saved_by="cron",
                time_budget_sec=None,
                parallel=True,
            )
            or {}
        )
    if result.get("ok") and not result.get("partial"):
        yday = gps_sync.yesterday_tashkent()
        rec = OFFICE.get_report(yday)
        cars = rec.get("cars") if isinstance(rec, dict) else None
        if not cars:
            with _gps_sync_lock:
                gps_sync.sync_today(
                    OFFICE,
                    DIRECTORY,
                    yday,
                    saved_by="cron-yday",
                    time_budget_sec=90,
                    parallel=True,
                )
    return {"ok": True, "date": d, "result": result}


@app.api_route("/", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
@app.api_route("/{full_path:path}", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
async def handle(request: Request, full_path: str = ""):
    path = request.url.path or "/"

    # Cron: darhol birinchi bayt — keyin to'liq sync (504 25s yechimi)
    if path == "/api/cron/gps-sync" and request.method in ("GET", "POST", "HEAD"):
        if not _cron_authorized(request):
            return Response(
                content=b'{"ok":false,"error":"Unauthorized"}',
                status_code=401,
                media_type="application/json",
            )
        if request.method == "HEAD":
            return Response(status_code=200, media_type="application/json")

        async def gen():
            # Fluid: initial response < 25s
            yield b'{"ok":true,"started":true}\n'
            try:
                result = await asyncio.to_thread(_run_gps_cron)
                yield (json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")
            except Exception as e:
                yield (
                    json.dumps({"ok": False, "error": str(e)[:200]}, ensure_ascii=False) + "\n"
                ).encode("utf-8")

        return StreamingResponse(gen(), media_type="application/x-ndjson")

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
