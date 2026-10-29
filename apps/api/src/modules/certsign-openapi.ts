// Operaciones de la firma con certificado propio (Firmador CalaSign) para /v1/openapi.json.
import { CertsignCertificateInput, CertsignSignatureInput } from "@calasign/shared";

const TAG = "Firma con certificado";

export const CERTSIGN_OPS = [
  {
    method: "get",
    path: "/v1/envelopes/{id}/certificate-signatures",
    tag: TAG,
    summary: "Progreso de las firmas con certificado del sobre (en orden)",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/certsign/pairing",
    tag: TAG,
    summary: "Código de un solo uso (10 min) y enlace calasign-firmador:// para el Firmador",
    description: "Solo para el firmante con certificado al que le toca firmar, con el sobre en awaiting_certificates.",
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/certsign/sessions/{code}",
    tag: TAG,
    summary: "Datos de la sesión del Firmador (sobre, firmante, requisitos, SHA-256 del documento)",
    auth: "none",
  },
  {
    method: "get",
    path: "/v1/certsign/sessions/{code}/document",
    tag: TAG,
    summary: "PDF de trabajo que se va a firmar",
    response: "pdf",
    auth: "none",
  },
  {
    method: "get",
    path: "/v1/certsign/sessions/{code}/prepared",
    tag: TAG,
    summary: "PDF preparado para la firma (revisión con el espacio reservado y el ByteRange)",
    description:
      "Disponible después de enviar el certificado (si no, 409 not_prepared). El Firmador recalcula el messageDigest sobre el ByteRange y verifica que la revisión anterior sea el PDF de trabajo anunciado.",
    response: "pdf",
    auth: "none",
  },
  {
    method: "post",
    path: "/v1/certsign/sessions/{code}/certificate",
    tag: TAG,
    summary: "Enviar la cadena del certificado: controles y preparación de la firma",
    description:
      "Controla vigencia, usos de clave, emisor, confianza e identidad. Si pasa, devuelve los atributos firmados (dataToSign) y su SHA-256 (digestToSign). Si no, 422 certificate_rejected.",
    body: CertsignCertificateInput,
    auth: "none",
  },
  {
    method: "post",
    path: "/v1/certsign/sessions/{code}/signature",
    tag: TAG,
    summary: "Enviar la firma del hash (RSA PKCS#1 v1.5 o ECDSA): se inserta como revisión PAdES B-T",
    body: CertsignSignatureInput,
    auth: "none",
  },
  { method: "get", path: "/v1/firmador/downloads", tag: TAG, summary: "Binarios del Firmador CalaSign disponibles", auth: "none" },
] as const;
