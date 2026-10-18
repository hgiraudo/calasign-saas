#!/usr/bin/env python3
"""Verificador XMLDSig independiente (lxml/libxml2 para C14N + cryptography para RSA).

Sirve para contrastar la salida de @calasign/xades con otra implementación de canonicalización.
Uso: python3 verify_xmldsig.py archivo.xml  → imprime JSON {"valid": bool, "references": [...], "error": ...}
Requiere lxml y cryptography (PYTHONPATH con lxml si no está instalado en el sistema).
"""
import base64
import copy
import hashlib
import json
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from lxml import etree

DS = "http://www.w3.org/2000/09/xmldsig#"
EXC = "http://www.w3.org/2001/10/xml-exc-c14n#"
ENV = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"
DIGESTS = {
    "http://www.w3.org/2001/04/xmlenc#sha256": hashlib.sha256,
    "http://www.w3.org/2001/04/xmlenc#sha512": hashlib.sha512,
    "http://www.w3.org/2000/09/xmldsig#sha1": hashlib.sha1,
}


def c14n(el, alg):
    return etree.tostring(el, method="c14n", exclusive=(alg == EXC), with_comments=False)


def main(path):
    raw = open(path, "rb").read()
    tree = etree.fromstring(raw)
    sig = tree.find(f".//{{{DS}}}Signature")
    si = sig.find(f"{{{DS}}}SignedInfo")
    c14n_alg = si.find(f"{{{DS}}}CanonicalizationMethod").get("Algorithm")
    refs = []
    for ref in si.findall(f"{{{DS}}}Reference"):
        uri = ref.get("URI")
        transforms = [t.get("Algorithm") for t in ref.findall(f".//{{{DS}}}Transform")]
        alg = EXC if EXC in transforms else "inclusive"
        if uri == "":
            doc = etree.fromstring(raw)
            s = doc.find(f".//{{{DS}}}Signature")
            if ENV in transforms:
                s.getparent().remove(s)
            target = doc
        else:
            found = tree.xpath(f"//*[@Id='{uri[1:]}' or @ID='{uri[1:]}' or @id='{uri[1:]}']")
            target = found[0] if found else None
        dm = ref.find(f"{{{DS}}}DigestMethod").get("Algorithm")
        expected = ref.find(f"{{{DS}}}DigestValue").text.strip()
        got = base64.b64encode(DIGESTS[dm](c14n(target, alg)).digest()).decode() if target is not None else None
        refs.append({"uri": uri, "valid": got == expected})
    cert_b64 = "".join(sig.find(f".//{{{DS}}}X509Certificate").text.split())
    cert = x509.load_der_x509_certificate(base64.b64decode(cert_b64))
    value = base64.b64decode("".join(sig.find(f"{{{DS}}}SignatureValue").text.split()))
    try:
        sig_method = si.find(f"{{{DS}}}SignatureMethod").get("Algorithm")
        algo = hashes.SHA1() if sig_method.endswith("#rsa-sha1") else hashes.SHA256()
        cert.public_key().verify(value, c14n(si, c14n_alg), padding.PKCS1v15(), algo)
        sig_ok = True
    except Exception:
        sig_ok = False
    print(json.dumps({"valid": sig_ok and all(r["valid"] for r in refs), "signatureValid": sig_ok, "references": refs}))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"valid": False, "error": str(e)}))
