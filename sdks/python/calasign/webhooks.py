"""Verificación de webhooks de CalaSign: `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Optional, Union

__all__ = ["WebhookSignatureError", "construct_event", "verify_signature"]


class WebhookSignatureError(Exception):
    pass


def construct_event(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> Dict[str, Any]:
    """Verifica la firma (y su antigüedad) y devuelve el evento. Usar el cuerpo CRUDO del POST."""
    if not header:
        raise WebhookSignatureError("Falta el header CalaSign-Signature")
    # `t=<unix>,v1=<hex>[,v1=<hex>]`: durante la rotación del secreto llegan dos v1 (nuevo y anterior).
    t_raw: Optional[str] = None
    v1s: List[str] = []
    for kv in header.split(","):
        k, _, v = kv.partition("=")
        k, v = k.strip(), v.strip()
        if k == "t":
            t_raw = v
        elif k == "v1" and v:
            v1s.append(v)
    try:
        t = int(t_raw or "")
    except ValueError:
        raise WebhookSignatureError("Header de firma mal formado") from None
    if not v1s:
        raise WebhookSignatureError("Header de firma mal formado")
    if abs(int(now if now is not None else time.time()) - t) > tolerance:
        raise WebhookSignatureError("Firma fuera de la tolerancia de tiempo")
    # HMAC sobre los bytes crudos: un cuerpo que no es UTF-8 no rompe la verificación (simplemente no coincide).
    raw = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + raw, hashlib.sha256).hexdigest()
    # En bytes: compare_digest con un str no ASCII (un header manipulado) lanza TypeError en vez de no coincidir.
    if not any(hmac.compare_digest(expected.encode(), v1.encode("utf-8", "surrogateescape")) for v1 in v1s):
        raise WebhookSignatureError("Firma inválida")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise WebhookSignatureError("El cuerpo del webhook no es JSON válido") from None


def verify_signature(payload: Union[str, bytes], header: Optional[str], secret: str, *, tolerance: int = 300, now: Optional[float] = None) -> bool:
    try:
        construct_event(payload, header, secret, tolerance=tolerance, now=now)
        return True
    except WebhookSignatureError:
        return False
