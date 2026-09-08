"""Vercel production entrypoint — barcha so'rovlar vm_server orqali."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
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


def _github_dispatch_gps_sync() -> dict:
    """
    Og'ir sync Vercelda emas — faqat GitHub Actions ni uyg'otadi (<2s).
    GH_PAT bo'lmasa: accepted, lekin dispatched=false (asosiy sync hali Actions schedule).
    """
    pat = (os.environ.get("GH_PAT") or os.environ.get("GITHUB_PAT") or "").strip()
    repo = (os.environ.get("GITHUB_REPOSITORY") or os.environ.get("GH_REPO") or "").strip()
    if not repo:
        owner = (os.environ.get("GH_OWNER") or "otaqulov2222").strip()
        name = (os.environ.get("GH_REPO_NAME") or "GPS-VaksinaMed").strip()
        repo = f"{owner}/{name}"
    ref = (os.environ.get("GH_REF") or "main").strip() or "main"
    workflow = (os.environ.get("GH_GPS_WORKFLOW") or "gps-sync.yml").strip() or "gps-sync.yml"

    if not pat:
        return {
            "ok": True,
            "accepted": True,
            "dispatched": False,
            "message": "GH_PAT yo'q — GitHub schedule ishlaydi. Zaxira uchun Vercelga GH_PAT qo'shing.",
        }

    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches"
    body = json.dumps({"ref": ref}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "VaksinaMed-GPS-Cron",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            code = getattr(resp, "status", 204) or 204
        return {
            "ok": True,
            "accepted": True,
            "dispatched": True,
            "http": int(code),
            "repo": repo,
            "ref": ref,
            "message": "GitHub Actions GPS sync ishga tushirildi.",
        }
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "ignore")[:180]
        return {
            "ok": False,
            "accepted": True,
            "dispatched": False,
            "http": int(e.code),
            "error": err or str(e.reason),
            "message": "GitHub dispatch xato — schedule hali ishlashi mumkin.",
        }
    except Exception as e:
        return {
            "ok": False,
            "accepted": True,
            "dispatched": False,
            "error": str(e)[:160],
            "message": "GitHub dispatch ulanmadi — schedule hali ishlashi mumkin.",
        }


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

    # Cron zaxira: og'ir sync YO'Q — faqat GitHub workflow_dispatch (tez 202).
    if path == "/api/cron/gps-sync" and request.method in ("GET", "POST", "HEAD"):
        if not _cron_authorized(request):
            return Response(
                content=b'{"ok":false,"error":"Unauthorized"}',
                status_code=401,
                media_type="application/json",
            )
        if request.method == "HEAD":
            return Response(status_code=202, media_type="application/json")
        payload = _github_dispatch_gps_sync()
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
