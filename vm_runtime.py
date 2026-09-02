"""Vercel serverless va lokal server uchun umumiy ishga tushirish."""
from __future__ import annotations

import threading

_init_lock = threading.Lock()
_ready = False


def ensure_app():
    """STORE/OFFICE bir marta yuklanadi (Vercel cold start)."""
    global _ready
    if _ready:
        return
    with _init_lock:
        if _ready:
            return
        from vm_server import init_app

        init_app()
        _ready = True
