// Casos de prueba de scripts/semgrep/calasign.yml: `semgrep --test scripts/semgrep/`. No es código que corra.
// Cada "ruleid:" tiene que marcarse en la línea siguiente y cada "ok:" no.
/* eslint-disable */
// @ts-nocheck

async function sql(req, db) {
  // ruleid: calasign-sql-con-entrada-del-pedido
  await db.query(`SELECT * FROM envelopes WHERE subject = '${req.query.q}'`);
  const order = req.query.order;
  // ruleid: calasign-sql-con-entrada-del-pedido
  await db.one<any>(`SELECT * FROM envelopes ORDER BY ${order}`, []);
  const limit = Math.min(500, Math.trunc(Number(req.query.limit)));
  // ok: calasign-sql-con-entrada-del-pedido
  await db.query(`SELECT * FROM envelopes LIMIT ${limit}`);
  // ok: calasign-sql-con-entrada-del-pedido
  await db.query(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
}

async function evidence(t) {
  // ruleid: calasign-evidencia-append-only
  await t.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [1]);
  // ruleid: calasign-evidencia-append-only
  await t.query(`UPDATE account_audit_log SET actor = $1`, [1]);
  // ruleid: calasign-evidencia-append-only
  await t.one<any>(`TRUNCATE envelope_events`);
  // ok: calasign-evidencia-append-only
  await t.query(`INSERT INTO envelope_events (id) VALUES ($1)`, [1]);
}

function gcm(key, iv) {
  // ruleid: calasign-gcm-sin-largo-de-tag
  const d = createDecipheriv("aes-256-gcm", key, iv);
  // ok: calasign-gcm-sin-largo-de-tag
  const d2 = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
}

function compare(signature, expected, hmac) {
  // ruleid: calasign-comparacion-de-secreto-no-constante
  if (signature === expected) return true;
  // ruleid: calasign-comparacion-de-secreto-no-constante
  if (req.headers.signature !== hmac) return false;
  // ok: calasign-comparacion-de-secreto-no-constante
  if (signature === undefined) return false;
  // ok: calasign-comparacion-de-secreto-no-constante
  if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return true;
}

function redirects(req, reply) {
  // ruleid: calasign-redirect-con-entrada-del-pedido
  reply.redirect(req.query.next);
  const to = req.query.returnTo;
  // ruleid: calasign-redirect-con-entrada-del-pedido
  return reply.redirect(to, 302);
  // ok: calasign-redirect-con-entrada-del-pedido
  reply.redirect(safeRedirectPath(req.query.next));
  // ok: calasign-redirect-con-entrada-del-pedido
  reply.redirect("/login");
}

function randoms() {
  // ruleid: calasign-random-no-criptografico
  const token = Math.random().toString(36).slice(2);
  // ruleid: calasign-random-no-criptografico
  const otpCode = Math.floor(Math.random() * 1e6);
  // ok: calasign-random-no-criptografico
  const jitter = Math.floor(Math.random() * 250);
}

function tls() {
  // ruleid: calasign-tls-sin-verificar
  https.request({ host: "x", rejectUnauthorized: false });
  // ok: calasign-tls-sin-verificar
  https.request({ host: "x" });
}

function messages(msg, target) {
  // ruleid: calasign-postmessage-a-cualquier-origen
  window.parent.postMessage(msg, "*");
  // ok: calasign-postmessage-a-cualquier-origen
  window.parent.postMessage(msg, target);
}

function Html({ html }) {
  // ruleid: calasign-html-sin-escapar-en-react
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function code(src) {
  // ruleid: calasign-eval
  return new Function("x", src);
}

async function sqlBuilders(req, db, params, reply) {
  const where = buildWhere(req.auth.tenantId, req.query) + envelopeSearchSql(req.query, params);
  params.push(req.query.limit);
  // ok: calasign-sql-con-entrada-del-pedido
  await db.query<any>(`SELECT * FROM x WHERE ${where} LIMIT $${params.length}`, params);
  const key = ACCOUNT_KEY[req.query.provider];
  // ok: calasign-sql-con-entrada-del-pedido
  await db.query(`SELECT 1 FROM c WHERE config->>'${key}' = $1`, [1]);
  // ruleid: calasign-redirect-con-entrada-del-pedido
  reply.redirect(`https://x.test/${req.query.to}`);
  // ok: calasign-sql-con-entrada-del-pedido
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`k:${req.body.id}`]);
}

// SEG-20: datos personales en logs y errores, y URL con query en el texto.
function piiLogs(req, d, r, recipient, signer, signers, tpl, log, app) {
  // ruleid: calasign-dato-personal-en-log
  d.log.warn({ envelopeId: 1, to: r.email }, "aviso fallido");
  // ruleid: calasign-dato-personal-en-log
  req.log.info({ data: req.body }, "pedido");
  // ruleid: calasign-dato-personal-en-log
  log.error(`no salió el aviso a ${recipient.phone}`);
  // ruleid: calasign-dato-personal-en-log
  console.error("falló el aviso", recipient);
  // ruleid: calasign-dato-personal-en-log
  app.log?.warn({ who: signer.name, doc: r.input?.signerCpf }, "x");
  // ok: calasign-dato-personal-en-log
  d.log.warn({ envelopeId: 1, recipientId: r.id, to: maskDestination(r.email) }, "aviso fallido");
  // ok: calasign-dato-personal-en-log
  d.log.info({ signers: signers.length, hasPhone: !!r.phone, template: tpl.name }, "x");
  // ok: calasign-dato-personal-en-log
  d.log.warn({ err: scrubPii(String(r.email)) }, "x");
}

function piiErrors(r, signer, signers, req, file) {
  // ruleid: calasign-dato-personal-en-error
  throw new CrmError(`no se encontró ${r.cpf} en el ERP`);
  // ruleid: calasign-dato-personal-en-error
  throw new AppError(409, "already_signed", `Ya firmó ${signer.email}`);
  // ruleid: calasign-dato-personal-en-error
  throw new AppError(403, "ip_blocked", `La IP ${req.ip} está bloqueada`);
  // ruleid: calasign-dato-personal-en-error
  throw new MappingError("crm_contact_unreachable", `"${r.contact.fullName}" no tiene correo`);
  // ok: calasign-dato-personal-en-error
  throw new MappingError("crm_contact_unreachable", `El contacto del rol "${r.role}" no tiene correo ni teléfono`);
  // ok: calasign-dato-personal-en-error
  throw new AppError(422, "signers_missing", `Faltan ${signers.length} firmantes`, { hasEmail: Boolean(r.email) });
  // ok: calasign-dato-personal-en-error
  throw new Error(`zip inválido: ${file.zip}`);
}

function urlsInErrors(c, r, url, res, d, t) {
  // ruleid: calasign-url-en-error-o-log
  throw new CrmError(`${c.provider} ${r.path}: HTTP ${res.status}`);
  // ruleid: calasign-url-en-error-o-log
  d.log.warn({ url: res.url, status: res.status }, "llamada fallida");
  // ruleid: calasign-url-en-error-o-log
  throw new Error(`${url}: HTTP ${res.status}`);
  // ok: calasign-url-en-error-o-log
  throw new CrmError(`${c.provider} ${redactPath(r.path)}: HTTP ${res.status}`);
  // ok: calasign-url-en-error-o-log
  throw new Error(`${redactUrl(url)}: HTTP ${res.status}`);
  // ok: calasign-url-en-error-o-log
  d.log.warn({ host: new URL(url).host, path: r.path.split("?")[0] }, "llamada fallida");
  // ok: calasign-url-en-error-o-log
  throw new AppError(402, "plan_limit", `Ampliá el plan en ${UPGRADE_URL}`, { docs: config.appUrl });
  // ok: calasign-url-en-error-o-log
  throw new MappingError("crm_status_field", `No hay un campo en ${objPath(t)}`);
}
