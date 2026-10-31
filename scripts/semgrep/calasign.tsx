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
