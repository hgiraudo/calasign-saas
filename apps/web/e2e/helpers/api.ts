// Datos de prueba armados por la API (rápido y sin depender de la UI), como scripts/e2e.mjs. La UI se usa sólo para
// lo que cada test prueba. Todo sintético: correos en example.com y un PDF generado acá (estandares, SEG-20).
import { expect, type APIRequestContext } from "@playwright/test";

export const PASSWORD = "una-clave-segura-123";

/** PDF mínimo de N páginas, generado a mano (sin dependencias). */
export function tinyPdf(pages = 1): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 18 Tf 72 760 Td (Contrato de prueba web - pagina ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
  expect(res.ok(), `${what} → HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface Cuenta {
  email: string;
  password: string;
  stamp: string;
}

/** Alta de cuenta: deja la sesión en la cookie del `request` (que es su propio frasco de cookies). */
export async function altaDeCuenta(request: APIRequestContext): Promise<Cuenta> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `web+${stamp}@example.com`;
  await ok(
    await request.post("/v1/auth/signup", {
      data: { name: "Ana Remitente", email, password: PASSWORD, organization: `ACME web ${stamp}`, locale: "es" },
    }),
    "alta de cuenta",
  );
  return { email, password: PASSWORD, stamp };
}

export interface SobreEnviado {
  envelopeId: string;
  signerName: string;
  token: string;
}

/** Sobre con un PDF, un firmante (firma + nombre) y enviado. Devuelve el token del link de firma del buzón. */
export async function sobreEnviado(request: APIRequestContext, cuenta: Cuenta, { locale = "es" } = {}): Promise<SobreEnviado> {
  const { envelope } = await ok<{ envelope: { id: string } }>(
    await request.post("/v1/envelopes", { data: { subject: `Contrato web ${cuenta.stamp}`, message: "Por favor firmá" } }),
    "crear sobre",
  );
  const doc = await ok<{ id: string }>(
    await request.post(`/v1/envelopes/${envelope.id}/documents`, {
      multipart: { file: { name: "contrato.pdf", mimeType: "application/pdf", buffer: tinyPdf() } },
    }),
    "subir PDF",
  );
  const recipientId = crypto.randomUUID();
  const signerName = `José Pérez ${cuenta.stamp}`;
  await ok(
    await request.put(`/v1/envelopes/${envelope.id}/recipients`, {
      data: {
        recipients: [{ id: recipientId, name: signerName, email: `jose+${cuenta.stamp}@example.com`, routingOrder: 1, channels: ["email"], locale }],
      },
    }),
    "destinatarios",
  );
  await ok(
    await request.put(`/v1/envelopes/${envelope.id}/fields`, {
      data: {
        fields: [
          { documentId: doc.id, recipientId, type: "signature", page: 0, x: 0.1, y: 0.6, width: 0.3, height: 0.08 },
          { documentId: doc.id, recipientId, type: "name", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.03 },
        ],
      },
    }),
    "campos",
  );
  await ok(await request.post(`/v1/envelopes/${envelope.id}/send`), "enviar");
  return { envelopeId: envelope.id, signerName, token: await linkDeFirma(request, signerName) };
}

/** Token del link de firma que llegó al buzón de desarrollo para ese firmante. */
export async function linkDeFirma(request: APIRequestContext, signerName: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const { items } = await ok<{ items: { text: string; link?: string }[] }>(await request.get("/dev/mailbox"), "buzón");
    const m = items.find((x) => x.text.includes(signerName) && x.link?.includes("/s/"));
    if (m?.link) return m.link.split("/s/")[1];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no llegó la invitación de ${signerName}`);
}

/** Espera a que el sobre termine de sellarse y devuelve el PDF final. */
export async function pdfSellado(request: APIRequestContext, envelopeId: string): Promise<Buffer> {
  for (let i = 0; i < 60; i++) {
    const { envelope } = await ok<{ envelope: { status: string } }>(await request.get(`/v1/envelopes/${envelopeId}`), "sobre");
    if (envelope.status === "completed") {
      const res = await request.get(`/v1/envelopes/${envelopeId}/signed.pdf`);
      expect(res.ok()).toBeTruthy();
      return Buffer.from(await res.body());
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("el sobre no terminó de sellarse");
}

/** Firma por la API (sin navegador): para los tests que necesitan un PDF ya sellado. */
export async function firmarPorApi(request: APIRequestContext, token: string): Promise<void> {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADElEQVR4nGNgoA4AAABIAAEuuDx+AAAAAElFTkSuQmCC";
  await ok(await request.post(`/v1/signing/${token}/consent`), "consentimiento");
  await ok(await request.post(`/v1/signing/${token}/complete`, { data: { fields: [], signature: { kind: "drawn", imagePng: PNG } } }), "firmar");
}
