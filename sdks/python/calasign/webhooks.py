"""Verificación de webhooks de CalaSign: `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional, Union

__all__ = ["WebhookSignatureError", "construct_event", "verify_signature"]


class WebhookSignatureError(Exception):
    pass


def construct_event(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> Dict[str, Any]:
    """Verifica la firma (y su antigüedad) y devuelve el evento. Usar el cuerpo CRUDO del POST."""
    if not header:
        raise WebhookSignatureError("Falta el header CalaSign-Signature")
    parts: Dict[str, str] = {}
    for kv in header.split(","):
        k, _, v = kv.partition("=")
        parts[k.strip()] = v.strip()
    try:
        t = int(parts["t"])
        v1 = parts["v1"]
    except (KeyError, ValueError):
        raise WebhookSignatureError("Header de firma mal formado") from None
    if abs(int(now if now is not None else time.time()) - t) > tolerance:
        raise WebhookSignatureError("Firma fuera de la tolerancia de tiempo")
    body = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    expected = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        raise WebhookSignatureError("Firma inválida")
    return json.loads(body)


def verify_signature(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> bool:
    try:
        construct_event(payload, header, secret, tolerance=tolerance, now=now)
        return True
    except WebhookSignatureError:
        return False
