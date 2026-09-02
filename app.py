"""Vercel production entrypoint — barcha so'rovlar vm_server orqali."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import Response

app = FastAPI()


def _client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").strip()
    if fwd:
        return fwd.split(",")[0].strip()
    return request.headers.get("x-real-ip") or "127.0.0.1"


@app.api_route("/", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
@app.api_route("/{full_path:path}", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
async def handle(request: Request, full_path: str = ""):
    from vm_server import dispatch_http

    body = await request.body()
    path = request.url.path or "/"
    if request.url.query:
        path += "?" + str(request.url.query)
    status, out_headers, out_body = dispatch_http(
        request.method,
        path,
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
