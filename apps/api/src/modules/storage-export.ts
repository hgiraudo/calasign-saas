// Exportación automática del PDF sellado a almacenamiento de la organización:
// Google Drive, Dropbox y OneDrive (OAuth de la organización) y cualquier bucket compatible con S3.
// Al completarse un sobre se encola un job por conexión activa (ver platform-fanout.ts).
import type { FastifyInstance } from "fastify";
import {
  ConnectStorageOAuthInput,
  CreateS3ConnectionInput,
  STORAGE_PROVIDERS,
  UpdateStorageConnectionInput,
  type StorageConnection,
  type StorageExport,
  type StorageProvider,
  type StorageProviderInfo,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { enqueue } from "../infra/queue";
import type { BlobStore } from "../infra/storage";
import { AppError, badRequest, notFound } from "../lib/errors";
import { decrypt, encrypt, iso, randomToken, uuidv7 } from "../lib/util";
import { hasPerm } from "./access";
import { auditFromRequest } from "./audit";
import { authenticate, type Services } from "./context";
import { assertPublicDestination, safeHttpAgent, safeHttpsAgent } from "./webhooks";

const isLocalEnv = () => config.environment === "local";

// ───────────────────────────── Proveedores OAuth ─────────────────────────────

type OAuthProvider = Exclude<StorageProvider, "s3">;

interface ProviderCfg {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  extraAuthorize: Record<string, string>;
}

function providerCfg(p: OAuthProvider): ProviderCfg {
  const env = process.env;
  if (p === "gdrive")
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      extraAuthorize: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    };
  if (p === "dropbox")
    return {
      clientId: env.DROPBOX_CLIENT_ID,
      clientSecret: env.DROPBOX_CLIENT_SECRET,
      authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scope: "files.content.write account_info.read",
      extraAuthorize: { token_access_type: "offline" },
    };
  const tenant = env.MS_TENANT || "common";
  return {
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope: "offline_access Files.ReadWrite User.Read",
    extraAuthorize: {},
  };
}

const isConfigured = (p: StorageProvider) => p === "s3" || Boolean(providerCfg(p).clientId && providerCfg(p).clientSecret);
const redirectUri = (p: OAuthProvider) => `${config.appUrl}/v1/storage/oauth/${p}/callback`;

interface OAuthCreds {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

async function tokenRequest(p: OAuthProvider, params: Record<string, string>): Promise<any> {
  const cfg = providerCfg(p);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: cfg.clientId!, client_secret: cfg.clientSecret!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`token ${p}: HTTP ${res.status} ${body.error_description ?? body.error ?? ""}`.trim());
  return body;
}

/** Devuelve un access token vigente; si hubo que refrescarlo, también las credenciales nuevas a guardar. */
async function freshToken(p: OAuthProvider, creds: OAuthCreds): Promise<{ token: string; updated: OAuthCreds | null }> {
  if (creds.expires_at - 60_000 > Date.now()) return { token: creds.access_token, updated: null };
  if (!creds.refresh_token) throw new Error("la conexión venció: hay que volver a conectarla");
  const b = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: creds.refresh_token });
  const updated: OAuthCreds = {
    access_token: b.access_token,
    refresh_token: b.refresh_token ?? creds.refresh_token,
    expires_at: Date.now() + Number(b.expires_in ?? 3600) * 1000,
  };
  return { token: updated.access_token, updated };
}

async function accountLabel(p: OAuthProvider, tokenBody: any): Promise<string | null> {
  try {
    if (p === "gdrive" && tokenBody.id_token) {
      const payload = JSON.parse(Buffer.from(String(tokenBody.id_token).split(".")[1], "base64url").toString("utf8"));
      return payload.email ?? null;
    }
    if (p === "dropbox") {
      const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return ((await r.json()) as any)?.email ?? null;
    }
    if (p === "onedrive") {
      const r = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { authorization: `Bearer ${tokenBody.access_token}` }, signal: AbortSignal.timeout(10_000) });
      const me: any = await r.json();
      return me?.mail ?? me?.userPrincipalName ?? null;
    }
  } catch {
    /* la etiqueta es opcional */
  }
  return null;
}

// ───────────────────────────── Subida por proveedor ─────────────────────────────

interface UploadResult {
  ref: string;
  /** Credenciales refrescadas o configuración actualizada (ej. id de carpeta creada). */
  creds?: unknown;
  config?: Record<string, unknown>;
}

async function check(res: Response, what: string) {
  if (res.ok) return res;
  const t = (await res.text().catch(() => "")).slice(0, 300);
  throw new Error(`${what}: HTTP ${res.status} ${t}`);
}

/** Con el scope drive.file la app solo ve lo que creó: se busca (o crea) la carpeta por nombre. */
async function findOrCreateGdriveFolder(token: string, folder: string): Promise<string> {
  const auth = { authorization: `Bearer ${token}` };
  const q = `name = '${folder.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found: any = await (await check(await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: auth }), "buscar carpeta")).json();
  if (found.files?.[0]?.id) return found.files[0].id;
  const created: any = await (
    await check(
      await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: folder, mimeType: "application/vnd.google-apps.folder" }),
      }),
      "crear carpeta",
    )
  ).json();
  return created.id;
}

/**
 * Drive: resuelve la carpeta UNA vez por conexión, con la fila bloqueada. Si no, varias exportaciones en paralelo
 * (p. ej. un envío masivo que se completa) no la encuentran todavía, cada una crea una carpeta con el mismo nombre
 * y los PDF quedan repartidos entre carpetas duplicadas.
 */
async function ensureGdriveFolder(db: Db, connId: string): Promise<any> {
  await db.tx(async (t) => {
    const row = await t.one<any>(`SELECT provider, config, credentials_enc FROM storage_connections WHERE id = $1 FOR UPDATE`, [connId]);
    const cfg = row?.config ?? {};
    if (!row || row.provider !== "gdrive" || !cfg.folder || cfg.folderId) return;
    const { token, updated } = await freshToken("gdrive", JSON.parse(decrypt(row.credentials_enc)));
    const folderId = await findOrCreateGdriveFolder(token, String(cfg.folder));
    if (updated) await t.query(`UPDATE storage_connections SET credentials_enc = $2 WHERE id = $1`, [connId, encrypt(JSON.stringify(updated))]);
    await t.query(`UPDATE storage_connections SET config = config || $2::jsonb, updated_at = now() WHERE id = $1`, [connId, JSON.stringify({ folderId })]);
  });
  return db.one<any>(`SELECT * FROM storage_connections WHERE id = $1`, [connId]);
}

/** La carpeta ya resuelta y fijada para esta conexión (Drive con carpeta elegida); si no, la fila tal cual. */
async function withResolvedFolder(db: Db, c: any): Promise<any> {
  if (c.provider !== "gdrive" || !c.config?.folder || c.config?.folderId) return c;
  return (await ensureGdriveFolder(db, c.id)) ?? c;
}

async function uploadGdrive(creds: OAuthCreds, cfg: any, name: string, bytes: Uint8Array): Promise<UploadResult> {
  const { token, updated } = await freshToken("gdrive", creds);
  const auth = { authorization: `Bearer ${token}` };
  let folderId: string | null = cfg.folderId ?? null;
  const newCfg: Record<string, unknown> = {};
  if (!folderId && cfg.folder) {
    folderId = await findOrCreateGdriveFolder(token, String(cfg.folder));
    newCfg.folderId = folderId;
  }
  const boundary = `calasign${randomToken(12)}`;
  const meta = JSON.stringify({ name, mimeType: "application/pdf", ...(folderId ? { parents: [folderId] } : {}) });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res: any = await (
    await check(
      await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
        method: "POST",
        headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(60_000),
      }),
      "subir a Drive",
    )
  ).json();
  return { ref: res.webViewLink ?? `gdrive:${res.id}`, creds: updated ?? undefined, config: Object.keys(newCfg).length ? newCfg : undefined };
}

async function uploadDropbox(creds: OAuthCreds, cfg: any, name: string, bytes: Uint8Array): Promise<UploadResult> {
  const { token, updated } = await freshToken("dropbox", creds);
  const folder = String(cfg.folder ?? "").replace(/^\/+|\/+$/g, "");
  const path = `/${folder ? `${folder}/` : ""}${name}`;
  // Dropbox-API-Arg viaja en un header: los caracteres no ASCII van escapados.
  const arg = JSON.stringify({ path, mode: "add", autorename: true, mute: true }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const res: any = await (
    await check(
      await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "dropbox-api-arg": arg },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(60_000),
      }),
      "subir a Dropbox",
    )
  ).json();
  return { ref: `dropbox:${res.path_display ?? path}`, creds: updated ?? undefined };
}

async function uploadOnedrive(creds: OAuthCreds, cfg: any, name: string, bytes: Uint8Array): Promise<UploadResult> {
  const { token, updated } = await freshToken("onedrive", creds);
  const folder = String(cfg.folder ?? "").replace(/^\/+|\/+$/g, "");
  const path = [folder, name].filter(Boolean).map(encodeURIComponent).join("/");
  const auth = { authorization: `Bearer ${token}` };
  let item: any;
  if (bytes.length <= 4 * 1024 * 1024) {
    item = await (
      await check(
        await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/pdf" },
          body: Buffer.from(bytes),
          signal: AbortSignal.timeout(60_000),
        }),
        "subir a OneDrive",
      )
    ).json();
  } else {
    // Archivos grandes: sesión de carga en partes de 5 MiB (múltiplo de 320 KiB).
    const session: any = await (
      await check(
        await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/createUploadSession`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
        }),
        "sesión de carga OneDrive",
      )
    ).json();
    const CHUNK = 16 * 320 * 1024;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, bytes.length);
      const r = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: { "content-range": `bytes ${off}-${end - 1}/${bytes.length}`, "content-length": String(end - off) },
        body: Buffer.from(bytes.subarray(off, end)),
        signal: AbortSignal.timeout(60_000),
      });
      await check(r, "parte OneDrive");
      if (end === bytes.length) item = await r.json();
    }
  }
  return { ref: item?.webUrl ?? `onedrive:${item?.id ?? path}`, creds: updated ?? undefined };
}

interface S3Creds {
  accessKeyId: string;
  secretAccessKey: string;
}

async function uploadS3(creds: S3Creds, cfg: any, name: string, bytes: Uint8Array): Promise<UploadResult> {
  await assertPublicDestination(cfg.endpoint);
  const m = await import("@aws-sdk/client-s3");
  const client = new m.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || "us-east-1",
    forcePathStyle: cfg.forcePathStyle !== false,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    // Compatibilidad con proveedores S3 que no implementan los checksums nuevos (MinIO, Wasabi, R2…).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // El endpoint lo elige el cliente: cada conexión valida la IP resuelta (sin ventana para DNS rebinding).
    // Con plazos: el endpoint lo controla el cliente y sin ellos un servidor que no responde retiene el job para siempre.
    requestHandler: { httpAgent: safeHttpAgent, httpsAgent: safeHttpsAgent, connectionTimeout: 10_000, requestTimeout: 60_000 },
  });
  const key = `${String(cfg.prefix ?? "").replace(/^\/+/, "")}${name}`;
  try {
    await client.send(new m.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: bytes, ContentType: "application/pdf" }), { abortSignal: AbortSignal.timeout(120_000) });
  } finally {
    client.destroy();
  }
  return { ref: `s3://${cfg.bucket}/${key}` };
}

async function uploadTo(provider: StorageProvider, credsEnc: string, cfg: any, name: string, bytes: Uint8Array): Promise<UploadResult> {
  const creds = JSON.parse(decrypt(credsEnc));
  if (provider === "gdrive") return uploadGdrive(creds, cfg, name, bytes);
  if (provider === "dropbox") return uploadDropbox(creds, cfg, name, bytes);
  if (provider === "onedrive") return uploadOnedrive(creds, cfg, name, bytes);
  return uploadS3(creds, cfg, name, bytes);
}

async function persistUpload(db: Db, connId: string, r: UploadResult) {
  if (r.creds) await db.query(`UPDATE storage_connections SET credentials_enc = $2, updated_at = now() WHERE id = $1`, [connId, encrypt(JSON.stringify(r.creds))]);
  if (r.config) await db.query(`UPDATE storage_connections SET config = config || $2::jsonb, updated_at = now() WHERE id = $1`, [connId, JSON.stringify(r.config)]);
}

function fileName(subject: string, envelopeId: string) {
  const safe = subject.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "documento";
  return `${safe} - ${envelopeId.slice(0, 8)}.pdf`;
}

// ───────────────────────────── Job de exportación ─────────────────────────────

export async function exportEnvelopeJob(db: Db, blobs: BlobStore, p: { connectionId: string; envelopeId: string }) {
  const c = await db.one<any>(`SELECT * FROM storage_connections WHERE id = $1`, [p.connectionId]);
  const ex = await db.one<any>(`SELECT * FROM storage_exports WHERE connection_id = $1 AND envelope_id = $2`, [p.connectionId, p.envelopeId]);
  if (!c || !ex || ex.status === "succeeded") return;
  if (!c.active) {
    await db.query(`UPDATE storage_exports SET status = 'failed', error = 'conexión desactivada', updated_at = now() WHERE id = $1`, [ex.id]);
    return;
  }
  const e = await db.one<any>(
    `SELECT e.subject, e.status, f.storage_key FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [p.envelopeId],
  );
  if (!e || e.status !== "completed") return;
  await db.query(`UPDATE storage_exports SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [ex.id]);
  try {
    const bytes = await blobs.get(e.storage_key);
    const cur = await withResolvedFolder(db, c);
    const r = await uploadTo(cur.provider, cur.credentials_enc, cur.config ?? {}, fileName(e.subject, p.envelopeId), bytes);
    await persistUpload(db, c.id, r);
    await db.query(`UPDATE storage_exports SET status = 'succeeded', remote_ref = $2, error = NULL, updated_at = now() WHERE id = $1`, [ex.id, r.ref]);
    await db.query(`UPDATE storage_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [c.id]);
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 500);
    await db.query(`UPDATE storage_exports SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [ex.id, msg]);
    await db.query(`UPDATE storage_connections SET last_error = $2 WHERE id = $1`, [c.id, msg]);
    throw err; // reintento con backoff de la cola
  }
}

/** Al completarse un sobre: un export pendiente + un job por conexión activa. */
export async function queueStorageExports(db: Db, tenantId: string, envelopeId: string) {
  const conns = await db.query<any>(`SELECT id FROM storage_connections WHERE tenant_id = $1 AND active`, [tenantId]);
  for (const c of conns) {
    await db.query(
      `INSERT INTO storage_exports (id, tenant_id, connection_id, envelope_id) VALUES ($1,$2,$3,$4) ON CONFLICT (connection_id, envelope_id) DO NOTHING`,
      [uuidv7(), tenantId, c.id, envelopeId],
    );
    await enqueue(db, "platform", { kind: "export", connectionId: c.id, envelopeId }, { dedupeKey: `exp:${c.id}:${envelopeId}` });
  }
}

// ───────────────────────────── API ─────────────────────────────

function targetOf(r: any): string {
  const cfg = r.config ?? {};
  if (r.provider === "s3") return `${cfg.bucket}/${cfg.prefix ?? ""}`;
  return cfg.folder ? String(cfg.folder) : "/";
}

const toApi = (r: any): StorageConnection => ({
  id: r.id,
  provider: r.provider,
  name: r.name,
  target: targetOf(r),
  accountLabel: r.account_label,
  active: r.active,
  createdAt: iso(r.created_at)!,
  lastSuccessAt: iso(r.last_success_at),
  lastError: r.last_error,
});

function validateS3Endpoint(raw: string) {
  const u = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && isLocalEnv())) throw badRequest("invalid_url", "El endpoint debe ser https");
  if (local && !isLocalEnv()) throw badRequest("invalid_url", "No se permiten endpoints locales");
  if (u.username || u.password) throw badRequest("invalid_url", "El endpoint no puede llevar credenciales");
  return u.origin;
}

interface OAuthState {
  t: string;
  u: string;
  p: OAuthProvider;
  n: string;
  f: string;
  exp: number;
}

export async function storageRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const load = async (tenantId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Conexión");
    const r = await s.db.one<any>(`SELECT * FROM storage_connections WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound("Conexión");
    return r;
  };

  app.get("/v1/storage/providers", { preHandler: auth }, async () => {
    const items: StorageProviderInfo[] = STORAGE_PROVIDERS.map((p) => ({ provider: p, configured: isConfigured(p) }));
    return { items };
  });

  app.get("/v1/storage/connections", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM storage_connections WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.auth!.tenantId]);
    return { items: rows.map(toApi) };
  });

  app.post("/v1/storage/connections/s3", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const input = CreateS3ConnectionInput.parse(req.body);
    const endpoint = validateS3Endpoint(input.endpoint);
    const prefix = input.prefix && !input.prefix.endsWith("/") ? `${input.prefix}/` : input.prefix ?? "";
    const cfg = { endpoint, region: input.region, bucket: input.bucket, prefix, forcePathStyle: input.forcePathStyle };
    const credsEnc = encrypt(JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }));
    // Prueba de escritura antes de guardar: así un error de credenciales se ve ahora y no al completar un sobre.
    try {
      await uploadTo("s3", credsEnc, cfg, "calasign-connection-test.pdf", Buffer.from("%PDF-1.4\n% CalaSign: prueba de conexión\n"));
    } catch (err) {
      throw badRequest("storage_test_failed", `No se pudo escribir en el bucket: ${String((err as Error).message ?? err).slice(0, 300)}`);
    }
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, account_label, created_by, last_success_at)
       VALUES ($1,$2,'s3',$3,$4,$5,$6,$7, now())`,
      [id, a.tenantId, input.name, JSON.stringify(cfg), credsEnc, `${input.accessKeyId.slice(0, 4)}… @ ${new URL(endpoint).host}`, a.userId],
    );
    await auditFromRequest(s.db, req, a, "storage.connected", { targetType: "storage_connection", targetId: id, data: { provider: "s3", name: input.name, bucket: input.bucket } });
    reply.code(201);
    return toApi(await load(a.tenantId, id));
  });

  app.post<{ Params: { provider: string } }>("/v1/storage/oauth/:provider/start", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const p = req.params.provider as OAuthProvider;
    if (!["gdrive", "dropbox", "onedrive"].includes(p)) throw notFound("Proveedor");
    if (!isConfigured(p)) throw new AppError(409, "provider_not_configured", "Este proveedor no está configurado en el servidor");
    if (!a.userId) throw new AppError(403, "session_required", "Conectar una cuenta requiere iniciar sesión en la web");
    const input = ConnectStorageOAuthInput.parse(req.body ?? {});
    const state: OAuthState = { t: a.tenantId, u: a.userId, p, n: input.name, f: input.folder ?? "", exp: Date.now() + 10 * 60_000 };
    const cfg = providerCfg(p);
    const url = new URL(cfg.authorizeUrl);
    for (const [k, v] of Object.entries({
      client_id: cfg.clientId!,
      redirect_uri: redirectUri(p),
      response_type: "code",
      scope: cfg.scope,
      state: encrypt(JSON.stringify(state)),
      ...cfg.extraAuthorize,
    }))
      url.searchParams.set(k, v);
    return { authorizeUrl: url.toString() };
  });

  // Vuelta del proveedor: el navegador trae la cookie de sesión; el estado cifrado ata la conexión a quien la inició.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/storage/oauth/:provider/callback",
    { preHandler: auth },
    async (req, reply) => {
      const a = req.auth!;
      const back = (q: string) => reply.redirect(`/app/settings/storage?${q}`);
      let st: OAuthState;
      try {
        st = JSON.parse(decrypt(String(req.query.state ?? "")));
      } catch {
        return back("error=invalid_state");
      }
      if (st.p !== req.params.provider || st.exp < Date.now() || st.u !== a.userId || st.t !== a.tenantId) return back("error=invalid_state");
      if (!hasPerm(a, "settings:manage")) return back("error=forbidden");
      if (req.query.error || !req.query.code) return back(`error=${encodeURIComponent(req.query.error ?? "no_code")}`);
      try {
        const body = await tokenRequest(st.p, { grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri(st.p) });
        const creds: OAuthCreds = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
        const label = await accountLabel(st.p, body);
        const id = uuidv7();
        await s.db.query(
          `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, account_label, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, a.tenantId, st.p, st.n, JSON.stringify({ folder: st.f }), encrypt(JSON.stringify(creds)), label, a.userId],
        );
        await auditFromRequest(s.db, req, a, "storage.connected", { targetType: "storage_connection", targetId: id, data: { provider: st.p, name: st.n } });
        return back(`connected=${st.p}`);
      } catch (err) {
        req.log.warn({ err: String(err) }, "no se pudo conectar el almacenamiento");
        return back("error=token_exchange_failed");
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/storage/connections/:id", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    const input = UpdateStorageConnectionInput.parse(req.body);
    const cfgPatch: Record<string, unknown> = {};
    if (input.folder !== undefined && r.provider !== "s3") {
      cfgPatch.folder = input.folder;
      cfgPatch.folderId = null; // Drive: se vuelve a buscar/crear la carpeta
    }
    if (input.prefix !== undefined && r.provider === "s3") cfgPatch.prefix = input.prefix && !input.prefix.endsWith("/") ? `${input.prefix}/` : input.prefix;
    await s.db.query(
      `UPDATE storage_connections SET name = COALESCE($2, name), active = COALESCE($3, active), config = config || $4::jsonb, updated_at = now() WHERE id = $1`,
      [r.id, input.name ?? null, input.active ?? null, JSON.stringify(cfgPatch)],
    );
    return toApi(await load(a.tenantId, r.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/storage/connections/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM storage_connections WHERE id = $1`, [r.id]);
    await auditFromRequest(s.db, req, a, "storage.disconnected", { targetType: "storage_connection", targetId: r.id, data: { provider: r.provider, name: r.name } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/storage/connections/:id/test", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = req.auth!;
    let r = await load(a.tenantId, req.params.id);
    try {
      r = await withResolvedFolder(s.db, r);
      const res = await uploadTo(r.provider, r.credentials_enc, r.config ?? {}, "calasign-connection-test.pdf", Buffer.from("%PDF-1.4\n% CalaSign: prueba de conexión\n"));
      await persistUpload(s.db, r.id, res);
      await s.db.query(`UPDATE storage_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [r.id]);
      return { ok: true, ref: res.ref, error: null };
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 300);
      await s.db.query(`UPDATE storage_connections SET last_error = $2 WHERE id = $1`, [r.id, msg]);
      return { ok: false, ref: null, error: msg };
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/storage/exports", { preHandler: auth }, async (req) => {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50));
    const rows = await s.db.query<any>(
      `SELECT x.*, c.name AS connection_name, e.subject FROM storage_exports x
         JOIN storage_connections c ON c.id = x.connection_id JOIN envelopes e ON e.id = x.envelope_id
        WHERE x.tenant_id = $1 ORDER BY x.created_at DESC LIMIT $2`,
      [req.auth!.tenantId, limit],
    );
    const items: StorageExport[] = rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      envelopeId: r.envelope_id,
      envelopeSubject: r.subject,
      status: r.status,
      attempts: r.attempts,
      remoteRef: r.remote_ref,
      error: r.error,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    }));
    return { items };
  });

  app.post<{ Params: { id: string } }>("/v1/storage/exports/:id/retry", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound("Exportación");
    const x = await s.db.one<any>(`SELECT * FROM storage_exports WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!x) throw notFound("Exportación");
    if (x.status === "succeeded") throw new AppError(409, "already_exported", "Ya se exportó");
    await s.db.query(`UPDATE storage_exports SET status = 'pending', error = NULL, updated_at = now() WHERE id = $1`, [x.id]);
    await enqueue(s.db, "platform", { kind: "export", connectionId: x.connection_id, envelopeId: x.envelope_id }, { dedupeKey: `exp:${x.connection_id}:${x.envelope_id}:${Date.now()}` });
    reply.code(202);
    return { queued: true };
  });
}
