// Contra una API local en marcha: CALASIGN_TEST_BASE=http://localhost:4000 pnpm --filter @calasign/sdk test
// Sin la variable (o sin API), se omite.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { CalaSign, constructWebhookEvent } from "../src/index";

const BASE = process.env.CALASIGN_TEST_BASE;
const up = BASE
  ? await fetch(`${BASE}/healthz`)
      .then((r) => r.ok)
      .catch(() => false)
  : false;

function tinyPdf() {
  const content = "BT /F1 18 Tf 72 760 Td (SDK Node) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe.skipIf(!up)("SDK contra la API local", () => {
  let apiKey = "";
  let cookie = "";
  const stamp = Date.now();

  beforeAll(async () => {
    const res = await fetch(`${BASE}/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SDK", email: `sdk+${stamp}@example.com`, password: "una-clave-segura-123", organization: `SDK ${stamp}` }),
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0];
    const k = await fetch(`${BASE}/v1/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "sdk" }),
    });
    apiKey = ((await k.json()) as any).secret;
  });

  it("ciclo de un sobre: crear (idempotente), subir, destinatarios, campos, enviar, listar y eventos", async () => {
    const cs = new CalaSign({ apiKey, baseUrl: BASE });
    const key = randomUUID();
    const a = await cs.envelopes.create({ subject: `SDK ${stamp}` } as never, { idempotencyKey: key });
    const b = await cs.envelopes.create({ subject: `SDK ${stamp}` } as never, { idempotencyKey: key });
    expect(b.envelope.id).toBe(a.envelope.id);
    const id = a.envelope.id;
    const doc = await cs.envelopes.uploadDocument(id, tinyPdf(), "contrato.pdf");
    const signer = randomUUID();
    await cs.envelopes.setRecipients(id, [{ id: signer, name: "Ana SDK", email: `ana-sdk+${stamp}@example.com` }]);
    await cs.envelopes.setFields(id, [
      { documentId: doc.id, recipientId: signer, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
    ]);
    const sent = await cs.envelopes.send(id);
    expect(sent.envelope.status).toBe("sent");
    const again = await cs.envelopes.send(id); // misma Idempotency-Key: respuesta repetida, sin error
    expect(again.envelope.id).toBe(id);
    const seen: string[] = [];
    for await (const e of cs.envelopes.iterate({ q: `SDK ${stamp}` })) seen.push(e.id);
    expect(seen).toContain(id);
    const events = await cs.envelopes.events(id);
    expect(events.map((e) => e.type)).toContain("envelope.sent");
    const err = await cs.envelopes.get(randomUUID()).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("sobre completo en una llamada: createAndSend con los bytes del PDF (multipart) e idempotente", async () => {
    const cs = new CalaSign({ apiKey, baseUrl: BASE });
    const key = randomUUID();
    const input = {
      subject: `SDK oneshot ${stamp}`,
      documents: [{ content: tinyPdf(), name: "contrato.pdf" }],
      recipients: [{ name: "Ana SDK", email: `ana-oneshot+${stamp}@example.com` }],
      fields: [{ type: "signature" as const, page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
    };
    const a = await cs.envelopes.createAndSend(input, { idempotencyKey: key });
    expect(a.envelope.status).toBe("sent");
    expect(a.documents[0].name).toBe("contrato.pdf");
    expect(a.fields[0].recipientId).toBe(a.recipients[0].id);
    const b = await cs.envelopes.createAndSend(input, { idempotencyKey: key });
    expect(b.envelope.id).toBe(a.envelope.id);
  });

  it("webhook real verificado con constructWebhookEvent", async () => {
    const received: { body: string; sig: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ body, sig: String(req.headers["calasign-signature"] ?? "") });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const cs = new CalaSign({ apiKey, baseUrl: BASE });
    const { secret, webhook: endpoint } = await cs.webhooks.create({ url: `http://127.0.0.1:${port}/hook`, events: ["envelope.completed"] } as never);
    await cs.webhooks.test(endpoint.id);
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 200));
    server.close();
    expect(received.length).toBeGreaterThan(0);
    const evt = constructWebhookEvent({ payload: received[0].body, header: received[0].sig, secret });
    expect(evt.type).toBe("webhook.test");
    await cs.webhooks.delete(endpoint.id);
  });

  it("OAuth client credentials: el SDK obtiene el token solo", async () => {
    const r = await fetch(`${BASE}/v1/oauth/apps`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "SDK app", grantTypes: ["client_credentials"], scopes: ["envelopes:read"], role: "member" }),
    });
    const { app, clientSecret } = (await r.json()) as any;
    const cs = new CalaSign({ oauth: { clientId: app.clientId, clientSecret }, baseUrl: BASE });
    const me = await cs.me();
    expect(me.tenant.name).toBe(`SDK ${stamp}`);
    const list = await cs.envelopes.list();
    expect(Array.isArray(list.items)).toBe(true);
    const err = await cs.envelopes.create({ subject: "no" } as never).catch((e) => e);
    expect(err.code).toBe("insufficient_scope");
  });
});
