// Fixtures del test de aislamiento entre organizaciones (tenant-isolation-routes.test.ts): un recurso de cada tipo que
// tiene ruta con id, insertado directo en la base (crear cada uno por la API costaría segundos y pasos que no prueban
// nada acá). Se siembra igual en las dos organizaciones: los de A sirven de "padre propio" en las variantes mixtas (el
// sobre de A con el documento de B) y como contenido esperado de los listados de A.
import type { Db } from "../src/infra/db";
import type { BlobStore } from "../src/infra/storage";
import { encrypt, randomToken, sha256Hex, uuidv7 } from "../src/lib/util";

export interface Fixtures {
  tenantId: string;
  ownerId: string;
  /** Marca que va en los nombres de todo lo sembrado: si aparece en una respuesta de la otra organización, es una fuga. */
  tag: string;
  ids: Record<string, string>;
  /** Link de firma del firmante del sobre enviado (credencial pública de la organización). */
  signerToken: string;
  /** Token SCIM de la organización. */
  scimToken: string;
}

const PAGES = JSON.stringify([{ width: 595, height: 842 }]);

/** PDF mínimo válido de una página (sintético). */
function tinyPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
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
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export async function seedTenant(db: Db, blobs: BlobStore, tenantId: string, ownerId: string, tag: string): Promise<Fixtures> {
  const ids: Record<string, string> = {};
  const id = (name: string) => (ids[name] = uuidv7());
  const q = (sql: string, params: unknown[]) => db.query(sql, params);
  const file = async (name: string, kind = "original") => {
    const bytes = tinyPdf(`Documento ${tag}`);
    const key = `${tenantId}/${name}.pdf`;
    await blobs.put(key, bytes, "application/pdf");
    await q(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,'application/pdf',$5,$6)`, [
      id(name),
      tenantId,
      kind,
      key,
      bytes.length,
      sha256Hex(bytes),
    ]);
    return ids[name];
  };

  // Un segundo miembro (para /v1/members/:userId y SCIM) y la sesión del dueño (para /v1/me/sessions/:id).
  id("member");
  await q(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'scrypt$x')`, [
    ids.member,
    `miembro-${tag}@example.com`,
    `Miembro ${tag}`,
  ]);
  await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'member')`, [tenantId, ids.member]);
  await q(`INSERT INTO scim_users (tenant_id, user_id, external_id, active) VALUES ($1,$2,$3,true)`, [tenantId, ids.member, `ext-${tag}`]);
  const ses = await db.one<{ id: string }>(`SELECT id FROM sessions WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [tenantId, ownerId]);
  ids.session = ses!.id;

  // Sobres: borrador, enviado y completado, cada uno con documento, firmante y un campo de adjunto.
  let signerToken = "";
  for (const state of ["draft", "sent", "completed"] as const) {
    const env = id(`env_${state}`);
    const fileId = await file(`file_${state}`);
    await q(
      `INSERT INTO envelopes (id, tenant_id, created_by, subject, status, sent_at, completed_at, signed_file_id)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 = 'draft' THEN NULL ELSE now() END, CASE WHEN $5 = 'completed' THEN now() END, $6)`,
      [env, tenantId, ownerId, `Sobre ${state} ${tag}`, state, state === "completed" ? fileId : null],
    );
    await q(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,$4,$5,1,$6)`, [
      id(`doc_${state}`),
      tenantId,
      env,
      `doc-${tag}.pdf`,
      fileId,
      PAGES,
    ]);
    const token = randomToken();
    if (state === "sent") signerToken = token;
    await q(
      // Con el consentimiento ya dado: si no, las rutas del link responden 409 consent_required antes de buscar el campo.
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, access_token_hash, sent_at, signed_at, consented_at)
       VALUES ($1,$2,$3,'signer',1,$4,$5,$6,$7, CASE WHEN $6 <> 'created' THEN now() END, CASE WHEN $6 = 'signed' THEN now() END,
               CASE WHEN $6 <> 'created' THEN now() END)`,
      [
        id(`rec_${state}`),
        tenantId,
        env,
        `Firmante ${tag}`,
        `firmante-${tag}@example.com`,
        { draft: "created", sent: "sent", completed: "signed" }[state],
        state === "draft" ? null : sha256Hex(token),
      ],
    );
    await q(
      `INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height, required, attachment_file_id, filled_at)
       VALUES ($1,$2,$3,$4,$5,'attachment',1,0.1,0.1,0.3,0.05,false,$6, now())`,
      [id(`field_${state}`), tenantId, env, ids[`doc_${state}`], ids[`rec_${state}`], await file(`attachment_${state}`, "attachment")],
    );
  }
  await q(
    `INSERT INTO signature_handoffs (id, tenant_id, envelope_id, recipient_id, access_token_hash, token_hash, token_enc, purpose, expires_at)
     SELECT $1, $2, $3, $4, r.access_token_hash, $5, $6, 'signature', now() + interval '1 hour' FROM recipients r WHERE r.id = $4`,
    [id("handoff"), tenantId, ids.env_sent, ids.rec_sent, sha256Hex(randomToken()), encrypt(randomToken())],
  );

  // Plantilla con documento y rol.
  await q(`INSERT INTO templates (id, tenant_id, name, created_by) VALUES ($1,$2,$3,$4)`, [id("template"), tenantId, `Plantilla ${tag}`, ownerId]);
  await q(`INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,$4,$5,1,$6)`, [
    id("template_doc"),
    tenantId,
    ids.template,
    `tpl-${tag}.pdf`,
    await file("template_file", "template"),
    PAGES,
  ]);
  await q(`INSERT INTO template_roles (id, tenant_id, template_id, name, position) VALUES ($1,$2,$3,'Firmante',0)`, [
    id("template_role"),
    tenantId,
    ids.template,
  ]);

  // Equipo.
  await q(`INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,$3)`, [id("group"), tenantId, `Grupo ${tag}`]);
  await q(`INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)`, [ids.group, ids.member]);
  await q(`INSERT INTO scim_groups (group_id, tenant_id, external_id) VALUES ($1,$2,$3)`, [ids.group, tenantId, `grp-${tag}`]);
  await q(`INSERT INTO roles (id, tenant_id, name, permissions) VALUES ($1,$2,$3,'{envelopes:create}')`, [id("role"), tenantId, `Rol ${tag}`]);
  await q(
    `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,'member',$4,$5, now() + interval '7 days')`,
    [id("invitation"), tenantId, `invitada-${tag}@example.com`, sha256Hex(randomToken()), ownerId],
  );
  await q(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role) VALUES ($1,$2,$3,'cs_test',$4,$5,'admin')`, [
    id("api_key"),
    tenantId,
    `Key ${tag}`,
    sha256Hex(randomToken()),
    ownerId,
  ]);
  const scimToken = randomToken();
  await q(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash, created_by) VALUES ($1,$2,$3,'scim',$4,$5)`, [
    id("scim_token"),
    tenantId,
    `SCIM ${tag}`,
    sha256Hex(scimToken),
    ownerId,
  ]);

  // Webhooks y avisos.
  await q(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, description, secret_enc, secret_prefix, created_by) VALUES ($1,$2,$3,$4,$5,'whsec_x',$6)`,
    [id("webhook"), tenantId, `https://hooks.example.com/${tag}`, `Webhook ${tag}`, encrypt(randomToken()), ownerId],
  );
  await q(
    `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, envelope_id, payload, status) VALUES ($1,$2,$3,$4,'envelope.sent',$5,$6,'failed')`,
    [id("webhook_delivery"), tenantId, ids.webhook, uuidv7(), ids.env_sent, JSON.stringify({ tag })],
  );
  await q(
    `INSERT INTO notification_integrations (id, tenant_id, kind, name, url_enc, url_hint, events) VALUES ($1,$2,'slack',$3,$4,'hooks.slack.com','{}')`,
    [id("notification_integration"), tenantId, `Slack ${tag}`, encrypt("https://hooks.slack.com/services/x")],
  );

  // Envío masivo.
  await q(
    `INSERT INTO bulk_sends (id, tenant_id, template_id, template_name, name, status, total, actor, created_by) VALUES ($1,$2,$3,$4,$5,'completed',1,$6,$7)`,
    [
      id("bulk_send"),
      tenantId,
      ids.template,
      `Plantilla ${tag}`,
      `Masivo ${tag}`,
      JSON.stringify({ type: "user", id: ownerId, label: tag }),
      ownerId,
    ],
  );
  await q(`INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status) VALUES ($1,$2,$3,1,$4,'failed')`, [
    id("bulk_send_item"),
    tenantId,
    ids.bulk_send,
    JSON.stringify({ tag }),
  ]);

  // Certificado de la organización.
  await q(
    `INSERT INTO tenant_certificates (id, tenant_id, name, subject, issuer, serial_number, not_before, not_after, sha256, key_algorithm, chain_pem, key_wrap_method, created_by)
     VALUES ($1,$2,$3,$4,$4,'01', now() - interval '1 day', now() + interval '1 year', $5, 'RSA', 'x', 'local', $6)`,
    [id("certificate"), tenantId, `Certificado ${tag}`, `CN=${tag}`, sha256Hex(tag), ownerId],
  );

  // Acuerdos (Fase 6).
  await q(`INSERT INTO clauses (id, tenant_id, slug, title, body) VALUES ($1,$2,$3,$4,'Texto')`, [
    id("clause"),
    tenantId,
    `clausula-${tag}`,
    `Cláusula ${tag}`,
  ]);
  await q(`INSERT INTO agreement_fields (id, tenant_id, key, label, type) VALUES ($1,$2,$3,$4,'text')`, [
    id("agreement_field"),
    tenantId,
    `campo_${tag.replace(/\W/g, "_")}`,
    `Campo ${tag}`,
  ]);
  await q(`INSERT INTO agreement_views (id, tenant_id, user_id, name, shared) VALUES ($1,$2,$3,$4,true)`, [
    id("agreement_view"),
    tenantId,
    ownerId,
    `Vista ${tag}`,
  ]);
  await q(`INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, owner_user_id) VALUES ($1,$2,'external',$3,$4,$5,$6)`, [
    id("agreement"),
    tenantId,
    await file("agreement_file"),
    `acuerdo-${tag}.pdf`,
    `Acuerdo ${tag}`,
    ownerId,
  ]);
  await q(`INSERT INTO document_templates (id, tenant_id, name, source, created_by) VALUES ($1,$2,$3,'Hola {{nombre}}',$4)`, [
    id("document_template"),
    tenantId,
    `Modelo ${tag}`,
    ownerId,
  ]);
  const steps = JSON.stringify([{ id: uuidv7(), type: "approval", name: `Aprobar ${tag}`, config: { approvers: [ownerId] } }]);
  await q(`INSERT INTO workflows (id, tenant_id, name, steps, signing_secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
    id("workflow"),
    tenantId,
    `Workflow ${tag}`,
    steps,
    encrypt(randomToken()),
    ownerId,
  ]);
  await q(`INSERT INTO workflow_runs (id, tenant_id, workflow_id, steps, status, started_by) VALUES ($1,$2,$3,$4,'waiting',$5)`, [
    id("workflow_run"),
    tenantId,
    ids.workflow,
    steps,
    ownerId,
  ]);
  await q(`INSERT INTO workflow_run_steps (run_id, idx, step_id, type, name, status) VALUES ($1,0,$2,'approval',$3,'waiting')`, [
    ids.workflow_run,
    uuidv7(),
    `Aprobar ${tag}`,
  ]);
  await q(`INSERT INTO negotiations (id, tenant_id, title, status, current_version, created_by) VALUES ($1,$2,$3,'open',2,$4)`, [
    id("negotiation"),
    tenantId,
    `Negociación ${tag}`,
    ownerId,
  ]);
  await q(
    `INSERT INTO negotiation_versions (negotiation_id, version, data, text_snapshot, author_type, author_name) VALUES ($1,1,'{}',$2,'user',$3), ($1,2,'{}',$2 || ' v2','user',$3)`,
    [ids.negotiation, `Texto ${tag}`, `Dueño ${tag}`],
  );
  await q(`INSERT INTO negotiation_comments (id, negotiation_id, version, author_type, author_name, body) VALUES ($1,$2,1,'user',$3,$4)`, [
    id("negotiation_comment"),
    ids.negotiation,
    `Dueño ${tag}`,
    `Comentario ${tag}`,
  ]);
  await q(
    `INSERT INTO negotiation_proposals (id, negotiation_id, version, author_type, author_name, kind, key, old_value, new_value) VALUES ($1,$2,1,'user',$3,'variable','monto','1','2')`,
    [id("negotiation_proposal"), ids.negotiation, `Dueño ${tag}`],
  );

  // Integraciones: CRM, conectores, almacenamiento, apps OAuth.
  await q(
    `INSERT INTO crm_connections (id, tenant_id, provider, name, auth_type, credentials_enc, created_by) VALUES ($1,$2,'hubspot',$3,'token',$4,$5)`,
    [id("crm_connection"), tenantId, `CRM ${tag}`, encrypt(JSON.stringify({ accessToken: "x" })), ownerId],
  );
  await q(`INSERT INTO crm_mappings (id, tenant_id, connection_id, name, object_type, template_id, created_by) VALUES ($1,$2,$3,$4,'deal',$5,$6)`, [
    id("crm_mapping"),
    tenantId,
    ids.crm_connection,
    `Mapeo ${tag}`,
    ids.template,
    ownerId,
  ]);
  await q(`INSERT INTO crm_runs (id, tenant_id, connection_id, mapping_id, kind, status, error) VALUES ($1,$2,$3,$4,'send','failed',$5)`, [
    id("crm_run"),
    tenantId,
    ids.crm_connection,
    ids.crm_mapping,
    `Error ${tag}`,
  ]);
  await q(
    `INSERT INTO connector_connections (id, tenant_id, provider, category, name, auth_type, credentials_enc, webhook_token_hash, webhook_token_enc, created_by)
     VALUES ($1,$2,'bamboohr','hris',$3,'api_key',$4,$5,$6,$7)`,
    [
      id("connector_connection"),
      tenantId,
      `Conector ${tag}`,
      encrypt(JSON.stringify({ apiKey: "x" })),
      sha256Hex(randomToken()),
      encrypt(randomToken()),
      ownerId,
    ],
  );
  await q(
    `INSERT INTO connector_flows (id, tenant_id, connection_id, name, object_type, template_id, created_by) VALUES ($1,$2,$3,$4,'employee',$5,$6)`,
    [id("connector_flow"), tenantId, ids.connector_connection, `Flujo ${tag}`, ids.template, ownerId],
  );
  await q(`INSERT INTO connector_runs (id, tenant_id, connection_id, flow_id, kind, status, error) VALUES ($1,$2,$3,$4,'send','failed',$5)`, [
    id("connector_run"),
    tenantId,
    ids.connector_connection,
    ids.connector_flow,
    `Error ${tag}`,
  ]);
  await q(`INSERT INTO storage_connections (id, tenant_id, provider, name, credentials_enc, created_by) VALUES ($1,$2,'s3',$3,$4,$5)`, [
    id("storage_connection"),
    tenantId,
    `Bucket ${tag}`,
    encrypt(JSON.stringify({ accessKeyId: "x", secretAccessKey: "y" })),
    ownerId,
  ]);
  await q(`INSERT INTO storage_exports (id, tenant_id, connection_id, envelope_id, status, error) VALUES ($1,$2,$3,$4,'failed',$5)`, [
    id("storage_export"),
    tenantId,
    ids.storage_connection,
    ids.env_completed,
    `Error ${tag}`,
  ]);
  ids.oauth_client_public = `cli_${tag.replace(/\W/g, "")}_${randomToken(6)}`;
  await q(
    `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes, created_by) VALUES ($1,$2,$3,$4,'{https://app.example.com/cb}','{authorization_code}','{envelopes:read}',$5)`,
    [id("oauth_client"), tenantId, ids.oauth_client_public, `App ${tag}`, ownerId],
  );

  // Formulario web.
  await q(`INSERT INTO web_forms (id, tenant_id, template_id, slug, name, signer_role_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id("web_form"),
    tenantId,
    ids.template,
    `form-${tag.replace(/\W/g, "")}`,
    `Formulario ${tag}`,
    ids.template_role,
    ownerId,
  ]);

  // Ajustes: marcas, dominios de correo y de SSO, supresiones.
  await q(`INSERT INTO brands (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)`, [
    id("brand"),
    tenantId,
    `Marca ${tag}`,
    `marca-${tag.replace(/\W/g, "")}`,
  ]);
  const host = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
  await q(`INSERT INTO brand_domains (id, tenant_id, brand_id, domain, verification_token) VALUES ($1,$2,$3,$4,$5)`, [
    id("brand_domain"),
    tenantId,
    ids.brand,
    `firma.${host}.example.com`,
    randomToken(8),
  ]);
  ids.email_domain = `correo.${host}.example.com`;
  await q(
    `INSERT INTO email_domains (id, tenant_id, domain, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc) VALUES ($1,$2,$3,$4,'cs1','x',$5)`,
    [id("email_domain_id"), tenantId, ids.email_domain, randomToken(8), encrypt("x")],
  );
  ids.sso_domain = `sso.${host}.example.com`;
  await q(`INSERT INTO sso_domains (domain, tenant_id, verification_token) VALUES ($1,$2,$3)`, [ids.sso_domain, tenantId, randomToken(8)]);
  ids.suppression = `rebota-${host}@example.com`;
  await q(`INSERT INTO email_suppressions (address, reason, tenant_id) VALUES ($1,'complaint',$2)`, [ids.suppression, tenantId]);

  return { tenantId, ownerId, tag, ids, signerToken, scimToken };
}
