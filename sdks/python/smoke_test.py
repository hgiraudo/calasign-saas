#!/usr/bin/env python3
"""Prueba de humo del SDK de Python.

    python3 -I sdks/python/smoke_test.py                         # solo pruebas sin red
    python3 -I sdks/python/smoke_test.py http://localhost:4000   # + contra una API local
"""
import hashlib
import hmac
import http.server
import json
import os
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from calasign import CalaSign, CalaSignError, ClientCredentials, WebhookSignatureError, construct_event, verify_signature  # noqa: E402


def ok(msg):
    print(f"✓ {msg}")


# ───────── Webhooks (sin red) ─────────
secret = "whsec_py"
body = json.dumps({"id": "evt_1", "type": "envelope.completed", "data": {}})
t = 1_800_000_000
sig = f"t={t},v1={hmac.new(secret.encode(), f'{t}.{body}'.encode(), hashlib.sha256).hexdigest()}"
assert construct_event(body, sig, secret, now=t)["type"] == "envelope.completed"
assert verify_signature(body.encode(), sig, secret, now=t)
assert not verify_signature(body.replace("completed", "voided"), sig, secret, now=t)
assert not verify_signature(body, sig, "otro", now=t)
assert not verify_signature(body, sig, secret, now=t + 1000)
assert not verify_signature(body, f"t={t},v1=é", secret, now=t)  # header no ASCII: no coincide, no lanza TypeError
try:
    construct_event(body, None, secret)
    raise AssertionError("debió fallar")
except WebhookSignatureError:
    pass
ok("verificación de webhooks: válida, alterada, secreto incorrecto, vieja y sin header")

# Un error de red al pedir el token OAuth también llega como CalaSignError (no como URLError suelto).
try:
    CalaSign(oauth=ClientCredentials("cli", "sec"), base_url="http://127.0.0.1:9", timeout=2, max_retries=0).me()
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.code == "network_error", e.code
ok("error de red al pedir el token OAuth: CalaSignError network_error")

# Un id que llega de afuera no cambia la ruta del pedido ("../webhooks" no llega a /v1/webhooks).
_paths = []


class _Rec(http.server.BaseHTTPRequestHandler):
    def _any(self):
        _paths.append((self.command, self.path))
        self.send_response(404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"code":"not_found","message":"x"}}')

    do_GET = do_DELETE = _any

    def log_message(self, *a):
        pass


_srv = http.server.HTTPServer(("127.0.0.1", 0), _Rec)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
_cs = CalaSign(api_key="k", base_url=f"http://127.0.0.1:{_srv.server_address[1]}", max_retries=0)
for call in (lambda: _cs.envelopes.get("../webhooks"), lambda: _cs.webhooks.delete("../envelopes/e1?x=1")):
    try:
        call()
        raise AssertionError("debió fallar")
    except CalaSignError:
        pass
_srv.shutdown()
assert _paths == [("GET", "/v1/envelopes/..%2Fwebhooks"), ("DELETE", "/v1/webhooks/..%2Fenvelopes%2Fe1%3Fx%3D1")], _paths
ok("ids en la ruta: se codifican como un segmento")

if len(sys.argv) < 2:
    print("\n(sin URL de API: se omiten las pruebas en línea)")
    sys.exit(0)

BASE = sys.argv[1].rstrip("/")
stamp = int(time.time() * 1000)


def raw(method, path, data=None, cookie=None):
    headers = {"Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers=headers)
    with urllib.request.urlopen(req) as res:
        return res.headers.get("Set-Cookie"), json.loads(res.read() or b"{}")


set_cookie, _ = raw("POST", "/v1/auth/signup", {"name": "Py", "email": f"py+{stamp}@example.com", "password": "una-clave-segura-123", "organization": f"Py {stamp}"})
cookie = set_cookie.split(";")[0]
_, key = raw("POST", "/v1/api-keys", {"name": "python"}, cookie)
cs = CalaSign(key["secret"], base_url=BASE)
ok("cuenta y API key")

PDF = (
    b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n"
    b"0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n180\n%%EOF\n"
)
idem = str(uuid.uuid4())
a = cs.envelopes.create({"subject": f"Python {stamp}"}, idempotency_key=idem)
b = cs.envelopes.create({"subject": f"Python {stamp}"}, idempotency_key=idem)
assert a["envelope"]["id"] == b["envelope"]["id"]
eid = a["envelope"]["id"]
doc = cs.envelopes.upload_document(eid, PDF, "contrato.pdf")
signer = str(uuid.uuid4())
cs.envelopes.set_recipients(eid, [{"id": signer, "name": "Ana Py", "email": f"ana-py+{stamp}@example.com"}])
cs.envelopes.set_fields(eid, [{"documentId": doc["id"], "recipientId": signer, "type": "signature", "page": 0, "x": 0.1, "y": 0.7, "width": 0.3, "height": 0.08}])
assert cs.envelopes.send(eid)["envelope"]["status"] == "sent"
assert eid in [e["id"] for e in cs.envelopes.iterate(q=f"Python {stamp}")]
assert "envelope.sent" in [e["type"] for e in cs.envelopes.events(eid)]
try:
    cs.envelopes.get(str(uuid.uuid4()))
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.status == 404
ok("sobre: crear (idempotente), subir, destinatarios, campos, enviar, iterar, eventos y 404 tipado")

# Fecha con zona horaria (lo que da datetime.isoformat() con tzinfo) y nombre de archivo con comillas.
import datetime as _dt  # noqa: E402

exp = (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(days=7)).isoformat()
c2 = cs.envelopes.create({"subject": f"Python tz {stamp}", "expiresAt": exp})
d2 = cs.envelopes.upload_document(c2["envelope"]["id"], PDF, 'Contrato "ACME".pdf')
assert d2["name"].startswith("Contrato %22ACME%22") or d2["name"].startswith('Contrato "ACME"'), d2["name"]
ok("expiresAt con zona horaria y nombre de archivo con comillas")

received = []


class Hook(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        received.append((self.rfile.read(n), self.headers.get("CalaSign-Signature")))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Hook)
threading.Thread(target=srv.serve_forever, daemon=True).start()
created = cs.webhooks.create(f"http://127.0.0.1:{srv.server_address[1]}/hook", events=["envelope.completed"])
cs.webhooks.test(created["webhook"]["id"])
for _ in range(50):
    if received:
        break
    time.sleep(0.2)
srv.shutdown()
payload, header = received[0]
assert construct_event(payload, header, created["secret"])["type"] == "webhook.test"
cs.webhooks.delete(created["webhook"]["id"])
ok("webhook real recibido y verificado")

_, app = raw("POST", "/v1/oauth/apps", {"name": "Py app", "grantTypes": ["client_credentials"], "scopes": ["envelopes:read"], "role": "member"}, cookie)
oc = CalaSign(oauth=ClientCredentials(app["app"]["clientId"], app["clientSecret"]), base_url=BASE)
assert oc.me()["tenant"]["name"] == f"Py {stamp}"
try:
    oc.envelopes.create({"subject": "no"})
    raise AssertionError("debió fallar")
except CalaSignError as e:
    assert e.code == "insufficient_scope"
ok("OAuth client credentials con scope de solo lectura")

print("\nSMOKE PYTHON OK")
