// Certificados de confianza de CalaSign: la raíz y las intermedias de la cadena del sello de plataforma, para importar
// en Adobe Acrobat (o en otro validador) y que reconozca como válidas las firmas de CalaSign. Hace falta mientras la
// cadena del sello no cuelgue de una raíz de la Adobe Approved Trust List (AATL): en dev y en local es la CA de
// desarrollo. Nunca se publica el certificado del sello en sí (no hace falta para confiar y no es una autoridad).
import type { FastifyInstance } from "fastify";
import type { TrustCertificate, TrustCertificatesResponse } from "@calasign/shared";
import { commonName, fingerprint, isSelfSigned, nameToString, parseCert } from "@calasign/pdf";
import { getSealProvider } from "../infra/seal";
import { notFound } from "../lib/errors";

interface CaCert {
  der: Uint8Array;
  info: TrustCertificate;
}

/** Atado a la cadena que devuelve el proveedor del sello: si cambia (sello renovado bajo otra CA), se recalcula. */
let cache: { chain: Uint8Array[]; items: CaCert[] } | null = null;

/** Las autoridades de la cadena del sello (sin el certificado del sello), de la raíz hacia abajo. */
export async function sealAuthorities(): Promise<CaCert[]> {
  const chain = await (await getSealProvider()).certificateChain();
  if (cache?.chain === chain) return cache.items;
  const out: CaCert[] = [];
  for (const der of chain.slice(1)) {
    const c = parseCert(der);
    const sha256 = fingerprint(der);
    out.push({
      der,
      info: {
        sha256,
        commonName: commonName(c.subject),
        subject: nameToString(c.subject),
        notBefore: c.notBefore.value.toISOString(),
        notAfter: c.notAfter.value.toISOString(),
        root: isSelfSigned(c),
        cerUrl: `/v1/public/trust-certificates/${sha256}.cer`,
        pemUrl: `/v1/public/trust-certificates/${sha256}.pem`,
      },
    });
  }
  // La raíz primero: es la que se marca como de confianza en Acrobat.
  out.sort((a, b) => Number(b.info.root) - Number(a.info.root));
  cache = { chain, items: out };
  return out;
}

const toPem = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${(
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? []
  ).join("\n")}\n-----END CERTIFICATE-----\n`;

export async function trustCertificateRoutes(app: FastifyInstance) {
  const rl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.get(
    "/v1/public/trust-certificates",
    rl,
    async (): Promise<TrustCertificatesResponse> => ({
      items: (await sealAuthorities()).map((c) => c.info),
    }),
  );

  app.get<{ Params: { file: string } }>("/v1/public/trust-certificates/:file", rl, async (req, reply) => {
    const m = /^([a-f0-9]{64})\.(cer|pem)$/.exec(req.params.file);
    const hit = m ? (await sealAuthorities()).find((c) => c.info.sha256 === m[1]) : undefined;
    if (!m || !hit) throw notFound("Certificado");
    const name = (hit.info.commonName ?? "calasign-ca").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "calasign-ca";
    reply.header("cache-control", "public, max-age=3600");
    reply.header("content-disposition", `attachment; filename="${name}.${m[2]}"`);
    if (m[2] === "cer") return reply.type("application/pkix-cert").send(Buffer.from(hit.der));
    return reply.type("application/x-pem-file").send(toPem(hit.der));
  });
}
