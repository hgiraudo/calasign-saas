// Exportación automática del PDF sellado a almacenamiento de la organización:
// Google Drive, Dropbox, OneDrive, SharePoint y Box (OAuth de la organización) y cualquier bucket compatible con S3.
// Opcionalmente también el certificado de evidencia (JSON con la cadena de eventos, connectors/evidence-file.ts).
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
import { createHash } from "node:crypto";
import { decrypt, encrypt, iso, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { hasPerm } from "./access";
import { auditFromRequest, changedValues } from "./audit";
import { authenticate, type Services } from "./context";
import { assertPublicDestination, safeHttpAgent, safeHttpsAgent } from "./webhooks";
import { evidenceCertificate, legacySafeBaseName, safeBaseName } from "./connectors/evidence-file";
import { alertTenantAdmins, type AlertLocale } from "./admin-alerts";
import { tenantBaseUrl } from "./custom-domains";
import { STORAGE_CREATOR_REMOVED } from "./member-access";

const isLocalEnv = () => config.environment === "local";

// Bases de las API (variables solo para pruebas con simuladores; por defecto las públicas).
const env = process.env;
const GRAPH = () => (env.MS_GRAPH_BASE ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
const MS_LOGIN = () => (env.MS_LOGIN_BASE ?? "https://login.microsoftonline.com").replace(/\/$/, "");
const BOX_API = () => (env.BOX_API_BASE ?? "https://api.box.com").replace(/\/$/, "");
const BOX_UPLOAD = () => (env.BOX_UPLOAD_BASE ?? "https://upload.box.com").replace(/\/$/, "");
const BOX_AUTHORIZE = () => env.BOX_AUTHORIZE_URL ?? "https://account.box.com/api/oauth2/authorize";

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
      // files.metadata.read: get_metadata para reconocer en un reintento lo que ya subió un intento anterior. Las
      // conexiones hechas antes de pedirlo no lo tienen: ahí se sube sin deduplicar (ver uploadDropbox).
      scope: "files.content.write files.metadata.read account_info.read",
      extraAuthorize: { token_access_type: "offline" },
    };
  if (p === "box")
    return {
      clientId: env.BOX_CLIENT_ID,
      clientSecret: env.BOX_CLIENT_SECRET,
      authorizeUrl: BOX_AUTHORIZE(),
      tokenUrl: `${BOX_API()}/oauth2/token`,
      // Los permisos de Box se fijan en la app (Read/Write all files and folders); el scope es informativo.
      scope: "root_readwrite",
      extraAuthorize: {},
    };
  const tenant = env.MS_TENANT || "common";
  return {
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    authorizeUrl: `${MS_LOGIN()}/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `${MS_LOGIN()}/${tenant}/oauth2/v2.0/token`,
    // Misma app de Entra ID para OneDrive y SharePoint; SharePoint pide además acceso a los sitios.
    scope: p === "sharepoint" ? "offline_access Sites.ReadWrite.All User.Read" : "offline_access Files.ReadWrite User.Read",
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

/** Guarda credenciales renovadas en cuanto se obtienen (ver freshToken). */
type OnRefresh = (creds: OAuthCreds) => Promise<void>;

/**
 * Devuelve un access token vigente; si hubo que refrescarlo, también las credenciales nuevas a guardar. `onRefresh` las
 * guarda en el acto: Box (y otros) invalidan el refresh token al usarlo, así que si la subida fallaba después de renovar
 * y las credenciales nuevas solo se guardaban al terminar bien, la conexión quedaba con un refresh token ya gastado
 * (invalid_grant en cada intento) y había que volver a conectarla.
 */
async function freshToken(p: OAuthProvider, creds: OAuthCreds, onRefresh?: OnRefresh): Promise<{ token: string; updated: OAuthCreds | null }> {
  if (creds.expires_at - 60_000 > Date.now()) return { token: creds.access_token, updated: null };
  if (!creds.refresh_token) throw new Error("la conexión venció: hay que volver a conectarla");
  const b = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: creds.refresh_token });
  const updated: OAuthCreds = {
    access_token: b.access_token,
    refresh_token: b.refresh_token ?? creds.refresh_token,
    expires_at: Date.now() + Number(b.expires_in ?? 3600) * 1000,
  };
  if (onRefresh) await onRefresh(updated);
  return { token: updated.access_token, updated };
}

/** Revocación de tokens por proveedor (bases variables solo para pruebas). Microsoft no tiene un endpoint de revocación. */
const GOOGLE_REVOKE = () => env.GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";
const DROPBOX_REVOKE = () => env.DROPBOX_REVOKE_URL ?? "https://api.dropboxapi.com/2/auth/token/revoke";

/**
 * Revoca (lo mejor posible) los tokens de una conexión OAuth: al desconectarla y cuando el callback obtuvo tokens pero no
 * pudo guardar la conexión. Si no, el acceso a la cuenta del usuario quedaba concedido a la app hasta que lo quitara a
 * mano. Google: el refresh token (revoca toda la concesión); Dropbox: con un access token vigente; Box: el refresh token
 * (o el access token); OneDrive/SharePoint: Microsoft no ofrece revocación por token (se omite). Nunca lanza: devuelve
 * si se pudo y el error, para el log.
 */
export async function revokeProviderToken(p: StorageProvider, creds: Partial<OAuthCreds>): Promise<{ ok: boolean; skipped?: true; error?: string }> {
  try {
    if (p === "s3" || p === "onedrive" || p === "sharepoint") return { ok: true, skipped: true };
    if (p === "gdrive") {
      const token = creds.refresh_token ?? creds.access_token;
      if (!token) return { ok: true, skipped: true };
      const res = await fetch(GOOGLE_REVOKE(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      // 400 invalid_token: ya estaba revocado o vencido.
      return res.ok || res.status === 400 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    }
    if (p === "dropbox") {
      let token = creds.access_token;
      if (!token || (creds.expires_at ?? 0) - 60_000 <= Date.now()) {
        if (!creds.refresh_token) return { ok: true, skipped: true };
        token = (await freshToken("dropbox", { access_token: "", refresh_token: creds.refresh_token, expires_at: 0 })).token;
      }
      const res = await fetch(DROPBOX_REVOKE(), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok || res.status === 401 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    }
    // Box
    const token = creds.refresh_token ?? creds.access_token;
    if (!token) return { ok: true, skipped: true };
    const cfg = providerCfg("box");
    const res = await fetch(`${BOX_API()}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId ?? "", client_secret: cfg.clientSecret ?? "", token }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

/** La cuenta de Google de una conexión (o de tokens recién obtenidos), para googleGrantShared. */
interface GoogleAccount {
  /** `sub` del id_token (id estable de la cuenta). */
  sub: string | null;
  /** account_label: el email del id_token. */
  label: string | null;
  /** Organización y persona que conectó: con qué comparar cuando no se sabe la cuenta. */
  tenantId: string;
  createdBy: string | null;
}

/**
 * Google revoca toda la concesión (la app y la cuenta de Google), no un token: revocar el de una conexión cortaba
 * también las demás conexiones de Drive con la misma cuenta (de esta u otra organización), que seguían "activas" con un
 * refresh token muerto. Solo se revoca si ninguna otra conexión usa esa cuenta:
 *  - con `sub` (id_token): otra conexión con el mismo sub, o una anterior a la columna (sin sub) con el mismo email;
 *  - sin sub pero con email: otra conexión con ese email (en cualquier organización);
 *  - sin sub ni email no se sabe la cuenta: solo cuentan las conexiones de Drive de la misma organización conectadas
 *    por la misma persona (antes, cualquier conexión sin etiqueta de cualquier organización impedía revocar).
 * En todos los casos, otra conexión de cuenta desconocida de la misma organización y persona también cuenta.
 */
async function googleGrantShared(db: Db, acc: GoogleAccount, excludeId: string | null): Promise<boolean> {
  const other = await db.one<any>(
    `SELECT 1 AS x FROM storage_connections
      WHERE provider = 'gdrive' AND ($5::uuid IS NULL OR id <> $5::uuid)
        AND (CASE
               WHEN $1::text IS NOT NULL THEN account_sub = $1::text
                 OR (account_sub IS NULL AND $2::text IS NOT NULL AND lower(account_label) = lower($2::text))
               WHEN $2::text IS NOT NULL THEN lower(account_label) = lower($2::text)
               ELSE tenant_id = $3::uuid AND created_by IS NOT DISTINCT FROM $4::uuid
             END
             -- Otra conexión de cuenta desconocida (sin sub ni email) de la misma organización y persona: puede ser esta.
             OR (account_sub IS NULL AND account_label IS NULL AND tenant_id = $3::uuid AND created_by IS NOT DISTINCT FROM $4::uuid))
      LIMIT 1`,
    [acc.sub, acc.label, acc.tenantId, acc.createdBy, excludeId],
  );
  return Boolean(other);
}

/** Revoca los tokens de una conexión guardada (credenciales cifradas); los fallos van al log. */
async function revokeStoredCreds(
  db: Db,
  provider: StorageProvider,
  credsEnc: string,
  log: { warn(o: object, m?: string): void; info?(o: object, m?: string): void },
  connectionId: string,
  account: GoogleAccount,
) {
  if (provider === "s3") return;
  if (provider === "gdrive" && (await googleGrantShared(db, account, connectionId))) {
    log.info?.({ provider, connectionId }, "no se revoca el acceso de Google: otra conexión usa la misma cuenta");
    return;
  }
  let creds: Partial<OAuthCreds>;
  try {
    creds = JSON.parse(decrypt(credsEnc));
  } catch {
    return;
  }
  const r = await revokeProviderToken(provider, creds);
  if (!r.ok) log.warn({ provider, connectionId, err: r.error }, "no se pudo revocar el acceso de la conexión de almacenamiento en el proveedor");
}

/** `sub` del id_token de Google (sin verificar la firma: viene directo del endpoint de tokens por TLS), o null. */
function googleSub(tokenBody: any): string | null {
  try {
    if (!tokenBody?.id_token) return null;
    const payload = JSON.parse(Buffer.from(String(tokenBody.id_token).split(".")[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
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
    if (p === "onedrive" || p === "sharepoint") {
      const r = await fetch(`${GRAPH()}/me`, { headers: { authorization: `Bearer ${tokenBody.access_token}` }, signal: AbortSignal.timeout(10_000) });
      const me: any = await r.json();
      return me?.mail ?? me?.userPrincipalName ?? null;
    }
    if (p === "box") {
      const r = await fetch(`${BOX_API()}/2.0/users/me?fields=login,name`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return ((await r.json()) as any)?.login ?? null;
    }
  } catch {
    /* la etiqueta es opcional */
  }
  return null;
}

// ───────────────────────────── Subida por proveedor ─────────────────────────────

/**
 * Identidad del archivo que se exporta, para no duplicarlo al reintentar: si un intento anterior llegó a subirlo pero
 * falló después (o el proceso murió antes de anotar la referencia), el reintento lo reutiliza si tiene los mismos bytes
 * (Drive: buscándolo por appProperties y comparando el sha256 guardado ahí; Dropbox: por ruta y content_hash) en lugar
 * de crear una copia.
 */
export interface UploadOpts {
  envelopeId: string;
  kind: "pdf" | "evidence";
  /** true desde el segundo intento (attempts > 1). */
  retry: boolean;
  /** Nombre con el formato anterior (id del sobre recortado): un intento previo al cambio pudo subirlo así. */
  legacyName?: string;
  /**
   * Re-exportación tras una renovación del sello: la copia que dejó la exportación anterior se reemplaza (nueva versión
   * del mismo archivo; Dropbox, OneDrive, SharePoint y Box guardan el historial) en lugar de sumar una «X (1).pdf» al
   * lado, que dejaba a la vista la del sello que vence. `ref` es el remote_ref de esa exportación (Dropbox lo usa como
   * ruta: si aquella copia había quedado renombrada, se reemplaza esa).
   */
  replace?: { ref: string | null };
}

/** Consulta de Drive por el archivo ya exportado de un sobre (appProperties que pone uploadGdrive). */
export function gdriveExportQuery(envelopeId: string, kind: string, folderId: string | null): string {
  const lit = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    `appProperties has { key='calasignEnvelopeId' and value='${lit(envelopeId)}' } and ` +
    `appProperties has { key='calasignKind' and value='${lit(kind)}' } and trashed = false` +
    (folderId ? ` and '${lit(folderId)}' in parents` : "")
  );
}

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

/**
 * Consulta de Drive para la carpeta. Dentro de '…' se escapan la comilla y también la barra invertida: sin escapar
 * la barra, una carpeta "Contratos\Firmados" (o que termina en \) arma una consulta inválida (HTTP 400) y no
 * funcionan ni las exportaciones ni la prueba de conexión.
 */
export function gdriveFolderQuery(folder: string, parentId?: string | null): string {
  const lit = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    `name = '${lit(folder)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false` +
    (parentId ? ` and '${lit(parentId)}' in parents` : "")
  );
}

/**
 * Las llamadas a la API de Drive aceptan unidades compartidas (Shared Drives): sin supportsAllDrives, una carpeta de una
 * unidad compartida da 404 y no se puede usar como destino. Las búsquedas dentro de una carpeta (in parents) también
 * tienen que incluir los elementos de las unidades compartidas.
 */
const DRIVE_ALL = "supportsAllDrives=true";
const driveListAll = (parentId: string | null | undefined) =>
  parentId ? `${DRIVE_ALL}&includeItemsFromAllDrives=true&corpora=allDrives` : DRIVE_ALL;

const GDRIVE_FOLDER_UNAVAILABLE =
  "la carpeta de Drive indicada no existe o la app no tiene acceso: usá una ruta (Contratos/2026) o el id de una carpeta creada por la app";

/** ¿Parece un id de carpeta de Drive (lo que va después de /folders/ en la URL)? Sin barras ni espacios. */
export const looksLikeGdriveId = (v: string) => /^[A-Za-z0-9_-]{25,}$/.test(v);

/**
 * Carpeta de destino de Drive. `folder` puede ser:
 *  - la URL …/folders/<id> de una carpeta (también de una unidad compartida): se usa si la app la ve, es una carpeta y
 *    no está en la papelera (con el scope drive.file la app solo ve lo que creó o lo que el usuario abrió con ella). Si
 *    no la ve, error claro (no se arma una ruta con los pedazos de la URL);
 *  - un id suelto: igual, pero si Drive responde 404/403 se toma como nombre de carpeta (comportamiento anterior): un
 *    nombre como "CalaSign_Signed_Documents" tiene forma de id y antes de esto las exportaciones de esas conexiones
 *    empezaban a fallar. Si existe pero no es una carpeta viva, error (es claramente un id);
 *  - una ruta "Contratos/2026": se busca (o crea) cada carpeta dentro de la anterior, como en Box. Antes "Contratos/2026"
 *    creaba UNA carpeta con la barra en el nombre.
 */
async function findOrCreateGdriveFolder(token: string, folder: string): Promise<string> {
  const auth = { authorization: `Bearer ${token}` };
  const raw = folder.trim();
  const isUrl = /^https?:\/\//i.test(raw);
  const fromUrl = isUrl ? (/\/folders\/([A-Za-z0-9_-]{10,})/.exec(raw)?.[1] ?? null) : null;
  const id = fromUrl ?? (looksLikeGdriveId(raw) ? raw : null);
  if (id) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed&${DRIVE_ALL}`, {
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const f: any = await res.json().catch(() => ({}));
      if (f?.id && f.mimeType === "application/vnd.google-apps.folder" && f.trashed !== true) return String(f.id);
      // Existe pero no es una carpeta viva: es un id, no un nombre.
      throw new Error(GDRIVE_FOLDER_UNAVAILABLE);
    } else if (res.status !== 404 && res.status !== 403) await check(res, "revisar carpeta");
  }
  // Una URL que no lleva a una carpeta que la app vea: no se arma una ruta con sus pedazos. Un id suelto que la app no
  // ve sigue como nombre de carpeta.
  if (isUrl) throw new Error(GDRIVE_FOLDER_UNAVAILABLE);
  const segments = raw
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
  let parent: string | null = null;
  for (const seg of segments.length ? segments : [raw]) {
    // Con timeout: corre con la fila de la conexión bloqueada, y sin él undici espera hasta 5 min a un Drive colgado,
    // trabando las demás exportaciones de esa conexión.
    const q = gdriveFolderQuery(seg, parent);
    const found: any = await (
      await check(
        await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&${driveListAll(parent)}`, {
          headers: auth,
          signal: AbortSignal.timeout(15_000),
        }),
        "buscar carpeta",
      )
    ).json();
    if (found.files?.[0]?.id) {
      parent = String(found.files[0].id);
      continue;
    }
    const created: any = await (
      await check(
        await fetch(`https://www.googleapis.com/drive/v3/files?fields=id&${DRIVE_ALL}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ name: seg.slice(0, 255), mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }),
          signal: AbortSignal.timeout(15_000),
        }),
        "crear carpeta",
      )
    ).json();
    parent = String(created.id);
  }
  return parent!;
}

/**
 * ¿La carpeta fijada sigue sirviendo? Drive acepta subir a una carpeta que está en la papelera, pero el archivo queda
 * en la papelera con ella ("trashed … from a trashed parent folder") y se borra solo a los 30 días: la exportación
 * daría OK y el PDF se perdería. Y si la papelera se vació, la carpeta da 404 y todas las exportaciones fallarían.
 */
export async function gdriveFolderUsable(token: string, folderId: string): Promise<boolean> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed&${DRIVE_ALL}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return false;
  const f: any = await (await check(res, "revisar carpeta")).json();
  return f?.trashed !== true;
}

/**
 * Drive: resuelve la carpeta UNA vez por conexión, con la fila bloqueada. Si no, varias exportaciones en paralelo
 * (p. ej. un envío masivo que se completa) no la encuentran todavía, cada una crea una carpeta con el mismo nombre
 * y los PDF quedan repartidos entre carpetas duplicadas. `stale`: id de una carpeta que ya no sirve (se reemplaza,
 * salvo que otra exportación ya lo haya hecho).
 */
async function ensureGdriveFolder(db: Db, connId: string, stale?: string): Promise<any> {
  await db.tx(async (t) => {
    const row = await t.one<any>(`SELECT provider, config, credentials_enc FROM storage_connections WHERE id = $1 FOR UPDATE`, [connId]);
    const cfg = row?.config ?? {};
    if (!row || row.provider !== "gdrive" || !cfg.folder || (cfg.folderId && cfg.folderId !== stale)) return;
    const { token, updated } = await freshToken("gdrive", JSON.parse(decrypt(row.credentials_enc)));
    const folderId = await findOrCreateGdriveFolder(token, String(cfg.folder));
    if (updated) await t.query(`UPDATE storage_connections SET credentials_enc = $2 WHERE id = $1`, [connId, encrypt(JSON.stringify(updated))]);
    await t.query(`UPDATE storage_connections SET config = config || $2::jsonb, updated_at = now() WHERE id = $1`, [
      connId,
      JSON.stringify({ folderId }),
    ]);
  });
  return db.one<any>(`SELECT * FROM storage_connections WHERE id = $1`, [connId]);
}

/** La carpeta ya resuelta y fijada para esta conexión (Drive con carpeta elegida); si no, la fila tal cual. */
async function withResolvedFolder(db: Db, c: any): Promise<any> {
  if (c.provider !== "gdrive" || !c.config?.folder) return c;
  const folderId = c.config?.folderId;
  if (!folderId) return (await ensureGdriveFolder(db, c.id)) ?? c;
  const { token, updated } = await freshToken("gdrive", JSON.parse(decrypt(c.credentials_enc)));
  if (updated) {
    c = { ...c, credentials_enc: encrypt(JSON.stringify(updated)) };
    await db.query(`UPDATE storage_connections SET credentials_enc = $2, updated_at = now() WHERE id = $1`, [c.id, c.credentials_enc]);
  }
  if (await gdriveFolderUsable(token, String(folderId))) return c;
  return (await ensureGdriveFolder(db, c.id, String(folderId))) ?? c;
}

export async function uploadGdrive(
  creds: OAuthCreds,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const { token, updated } = await freshToken("gdrive", creds, onRefresh);
  const auth = { authorization: `Bearer ${token}` };
  let folderId: string | null = cfg.folderId ?? null;
  const newCfg: Record<string, unknown> = {};
  if (!folderId && cfg.folder) {
    folderId = await findOrCreateGdriveFolder(token, String(cfg.folder));
    newCfg.folderId = folderId;
  }
  const done = (id: string, link?: string): UploadResult => ({
    ref: link ?? `gdrive:${id}`,
    creds: updated ?? undefined,
    config: Object.keys(newCfg).length ? newCfg : undefined,
  });
  const sha = sha256Hex(bytes);
  // Reintento: si un intento anterior ya lo subió, se usa ese (Drive permite nombres repetidos: subir de nuevo
  // dejaba dos copias del mismo PDF en la carpeta). Solo si son los mismos bytes (sha256 en appProperties): si el
  // contenido cambió entre intentos (renovación del sello, certificado regenerado) se reemplaza el contenido de ese
  // mismo archivo, que es de este sobre y de este tipo, en lugar de dejar el viejo o crear otro al lado.
  if (opts?.retry) {
    const q = gdriveExportQuery(opts.envelopeId, opts.kind, folderId);
    const found: any = await (
      await check(
        await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink,appProperties)&pageSize=10&${driveListAll(folderId)}`,
          {
            headers: auth,
            signal: AbortSignal.timeout(15_000),
          },
        ),
        "buscar exportación previa",
      )
    ).json();
    const files: any[] = Array.isArray(found?.files) ? found.files : [];
    const same = files.find((f) => f?.id && f.appProperties?.calasignSha256 === sha);
    if (same) return done(same.id, same.webViewLink);
    const prev = files.find((f) => f?.id);
    if (prev) {
      const boundary = `calasign${randomToken(12)}`;
      // Con el nombre actual: un archivo subido con el formato viejo de nombre (8 caracteres del id) queda renombrado.
      const meta = JSON.stringify({ name, appProperties: { calasignSha256: sha } });
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
        ),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const upd: any = await (
        await check(
          await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(prev.id)}?uploadType=multipart&fields=id,webViewLink&${DRIVE_ALL}`,
            {
              method: "PATCH",
              headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
              body,
              signal: AbortSignal.timeout(60_000),
            },
          ),
          "actualizar exportación previa en Drive",
        )
      ).json();
      return done(upd.id ?? prev.id, upd.webViewLink ?? prev.webViewLink);
    }
  }
  const boundary = `calasign${randomToken(12)}`;
  const appProperties = opts ? { calasignEnvelopeId: opts.envelopeId, calasignKind: opts.kind, calasignSha256: sha } : undefined;
  const meta = JSON.stringify({
    name,
    mimeType: contentType,
    ...(folderId ? { parents: [folderId] } : {}),
    ...(appProperties ? { appProperties } : {}),
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res: any = await (
    await check(
      await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&${DRIVE_ALL}`, {
        method: "POST",
        headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(60_000),
      }),
      "subir a Drive",
    )
  ).json();
  return done(res.id, res.webViewLink);
}

/**
 * content_hash de Dropbox (https://www.dropbox.com/developers/reference/content-hash): SHA-256 de cada bloque de
 * 4 MiB, concatenados, y SHA-256 de esa concatenación, en hex.
 */
export function dropboxContentHash(bytes: Uint8Array): string {
  const BLOCK = 4 * 1024 * 1024;
  const outer = createHash("sha256");
  for (let off = 0; off < bytes.length; off += BLOCK)
    outer.update(
      createHash("sha256")
        .update(bytes.subarray(off, off + BLOCK))
        .digest(),
    );
  return outer.digest("hex");
}

/** La conexión no tiene permiso para leer metadatos (scope files.metadata.read): no se puede deduplicar. */
const DROPBOX_NO_METADATA_SCOPE = Symbol("dropbox-no-metadata-scope");

/**
 * files/get_metadata: null si la ruta no existe (409 path/not_found); DROPBOX_NO_METADATA_SCOPE si al token le falta el
 * scope (401 missing_scope, o un 400 que lo menciona: app o conexión anterior a pedir files.metadata.read).
 */
async function dropboxMetadata(token: string, path: string): Promise<any | null | typeof DROPBOX_NO_METADATA_SCOPE> {
  const res = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 409) {
    const t = await res.text().catch(() => "");
    if (/not_found/.test(t)) return null;
    throw new Error(`buscar exportación previa en Dropbox: HTTP 409 ${t.slice(0, 300)}`);
  }
  if (res.status === 401 || res.status === 400) {
    const t = await res.text().catch(() => "");
    if (/scope/i.test(t)) return DROPBOX_NO_METADATA_SCOPE;
    throw new Error(`buscar exportación previa en Dropbox: HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  return (await check(res, "buscar exportación previa en Dropbox")).json();
}

export async function uploadDropbox(
  creds: OAuthCreds,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  _contentType: string,
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const { token, updated } = await freshToken("dropbox", creds, onRefresh);
  const folder = String(cfg.folder ?? "").replace(/^\/+|\/+$/g, "");
  const pathOf = (n: string) => `/${folder ? `${folder}/` : ""}${n}`;
  const path = pathOf(name);
  // Nunca "overwrite": aunque el nombre lleve el id del sobre, en la ruta puede haber otro archivo (uno que alguien
  // dejó con ese nombre, o el de otro sobre con el formato viejo de nombre). En un reintento se busca lo que un intento
  // anterior pudo haber subido (nombre actual y, por los reintentos en curso al cambiar el formato, el anterior) y se
  // reutiliza solo si es byte a byte lo mismo (content_hash de Dropbox); si no, "add" con autorename. Sin permiso para
  // leer metadatos (conexión anterior a pedir files.metadata.read) se sube igual, sin deduplicar: fallar siempre
  // dejaba la exportación trabada; con autorename, a lo sumo queda una copia de más. La excepción es la renovación del
  // sello (opts.replace): ahí se pisa la copia que dejó nuestra exportación anterior, y Dropbox conserva la versión vieja.
  if (opts?.retry) {
    const mine = dropboxContentHash(bytes);
    for (const p of [path, ...(opts.legacyName && opts.legacyName !== name ? [pathOf(opts.legacyName)] : [])]) {
      const meta = await dropboxMetadata(token, p);
      if (meta === DROPBOX_NO_METADATA_SCOPE) break;
      if (meta?.[".tag"] === "file" && meta.content_hash === mine) return { ref: `dropbox:${meta.path_display ?? p}`, creds: updated ?? undefined };
    }
  }
  // Renovación del sello: se pisa la copia propia de la exportación anterior (Dropbox guarda la versión vieja).
  const replacePath = opts?.replace ? (opts.replace.ref?.startsWith("dropbox:") && opts.kind === "pdf" ? opts.replace.ref.slice(8) : path) : null;
  // Dropbox-API-Arg viaja en un header: los caracteres no ASCII van escapados.
  const arg = JSON.stringify(
    replacePath ? { path: replacePath, mode: "overwrite", autorename: false, mute: true } : { path, mode: "add", autorename: true, mute: true },
  ).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
  return { ref: `dropbox:${res.path_display ?? replacePath ?? path}`, creds: updated ?? undefined };
}

export async function uploadOnedrive(
  creds: OAuthCreds,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const { token, updated } = await freshToken("onedrive", creds, onRefresh);
  const item = await graphUpload(token, `${GRAPH()}/me/drive`, cfg, name, bytes, contentType, "OneDrive", opts);
  return { ref: item?.webUrl ?? `onedrive:${item?.id ?? name}`, creds: updated ?? undefined };
}

export async function uploadSharepoint(
  creds: OAuthCreds,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const { token, updated } = await freshToken("sharepoint", creds, onRefresh);
  if (!cfg.driveId) throw new Error("conexión de SharePoint sin biblioteca resuelta: volvé a conectarla");
  const item = await graphUpload(
    token,
    `${GRAPH()}/drives/${encodeURIComponent(String(cfg.driveId))}`,
    cfg,
    name,
    bytes,
    contentType,
    "SharePoint",
    opts,
  );
  return { ref: item?.webUrl ?? `sharepoint:${item?.id ?? name}`, creds: updated ?? undefined };
}

/**
 * QuickXorHash de Microsoft (el hash que Graph informa en file.hashes.quickXorHash para OneDrive para empresas y
 * SharePoint): https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash. 160 bits, base64.
 */
export function quickXorHash(bytes: Uint8Array): string {
  const WIDTH = 160;
  const SHIFT = 11;
  const data = [0n, 0n, 0n];
  const MASK64 = (1n << 64n) - 1n;
  let vectorIndex = 0;
  let vectorOffset = 0;
  const iterations = Math.min(bytes.length, WIDTH);
  for (let i = 0; i < iterations; i++) {
    const isLast = vectorIndex === data.length - 1;
    const bitsInCell = isLast ? 32 : 64;
    // XOR de todos los bytes que caen en esta posición (cada 160): mismo resultado que aplicarlos de a uno.
    let x = 0;
    for (let j = i; j < bytes.length; j += WIDTH) x ^= bytes[j];
    const xb = BigInt(x);
    if (vectorOffset <= bitsInCell - 8) {
      data[vectorIndex] = (data[vectorIndex] ^ (xb << BigInt(vectorOffset))) & MASK64;
    } else {
      const index2 = isLast ? 0 : vectorIndex + 1;
      const low = bitsInCell - vectorOffset;
      data[vectorIndex] = (data[vectorIndex] ^ (xb << BigInt(vectorOffset))) & MASK64;
      data[index2] = (data[index2] ^ (xb >> BigInt(low))) & MASK64;
    }
    vectorOffset += SHIFT;
    while (vectorOffset >= bitsInCell) {
      vectorIndex = isLast ? 0 : vectorIndex + 1;
      vectorOffset -= bitsInCell;
    }
  }
  const out = Buffer.alloc(20);
  out.writeBigUInt64LE(data[0], 0);
  out.writeBigUInt64LE(data[1], 8);
  out.writeUInt32LE(Number(data[2] & 0xffffffffn), 16);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length));
  for (let i = 0; i < 8; i++) out[12 + i] ^= len[i];
  return out.toString("base64");
}

/** ¿El archivo de Graph tiene los mismos bytes? sha256Hash/sha1Hash (OneDrive personal) o quickXorHash (empresas). */
export function graphSameContent(item: any, bytes: Uint8Array): boolean {
  const h = item?.file?.hashes;
  if (!h || typeof h !== "object") return false;
  if (typeof h.sha256Hash === "string" && h.sha256Hash) return h.sha256Hash.toLowerCase() === sha256Hex(bytes);
  if (typeof h.sha1Hash === "string" && h.sha1Hash) return h.sha1Hash.toLowerCase() === createHash("sha1").update(bytes).digest("hex");
  if (typeof h.quickXorHash === "string" && h.quickXorHash) return h.quickXorHash === quickXorHash(bytes);
  return false;
}

/** Valida la URL de un sitio de SharePoint (https://empresa.sharepoint.com/sites/Legal). */
export function parseSharepointSite(raw: string): { host: string; path: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("invalid_url", "URL de sitio de SharePoint inválida");
  }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname) && isLocalEnv();
  if (!local && (u.protocol !== "https:" || !/\.sharepoint(-df)?\.com$/i.test(u.hostname) || u.username || u.password)) {
    throw badRequest("invalid_url", "El sitio tiene que ser https://<empresa>.sharepoint.com/sites/<sitio>");
  }
  // Solo la ruta del sitio (/sites/X o /teams/X); lo que venga después (/Shared Documents/Forms/…) se descarta.
  const m = /^\/(sites|teams)\/[^/]+/i.exec(decodeURIComponent(u.pathname));
  return { host: u.hostname, path: m ? m[0] : "" };
}

/** Resuelve sitio y biblioteca de SharePoint a ids de Graph (se guardan en la conexión). */
export async function resolveSharepointDrive(
  token: string,
  siteUrl: string,
  library?: string | null,
): Promise<{ siteId: string; driveId: string; driveName: string | null }> {
  const { host, path } = parseSharepointSite(siteUrl);
  const auth = { authorization: `Bearer ${token}` };
  const siteRef = path ? `${host}:${path.split("/").map(encodeURIComponent).join("/")}` : host;
  const site: any = await (
    await check(await fetch(`${GRAPH()}/sites/${siteRef}?$select=id,webUrl`, { headers: auth, signal: AbortSignal.timeout(15_000) }), "buscar sitio")
  ).json();
  if (library) {
    const drives: any = await (
      await check(
        await fetch(`${GRAPH()}/sites/${encodeURIComponent(site.id)}/drives?$select=id,name`, { headers: auth, signal: AbortSignal.timeout(15_000) }),
        "listar bibliotecas",
      )
    ).json();
    const d = (drives.value ?? []).find((x: any) => String(x.name).toLowerCase() === library.toLowerCase());
    if (!d) throw new Error(`no existe la biblioteca "${library}" en el sitio`);
    return { siteId: site.id, driveId: d.id, driveName: d.name };
  }
  const d: any = await (
    await check(
      await fetch(`${GRAPH()}/sites/${encodeURIComponent(site.id)}/drive?$select=id,name`, { headers: auth, signal: AbortSignal.timeout(15_000) }),
      "biblioteca del sitio",
    )
  ).json();
  return { siteId: site.id, driveId: d.id, driveName: d.name ?? null };
}

/**
 * Subida a un drive de Graph (OneDrive del usuario o biblioteca de SharePoint). En un reintento se busca por ruta lo que
 * un intento anterior pudo haber subido (nombre actual y el del formato anterior) y, si tiene los mismos bytes (hash de
 * Graph), se reutiliza en lugar de subir una copia "(1)" con conflictBehavior=rename.
 */
async function graphUpload(
  token: string,
  driveBase: string,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  what: string,
  opts?: UploadOpts,
): Promise<any> {
  // Cada segmento por separado: con la carpeta entera en encodeURIComponent, "Contratos/2026" viajaba como
  // "Contratos%2F2026" y Graph lo toma como un nombre con "/" (inválido) en lugar de una subcarpeta.
  const folder = String(cfg.folder ?? "")
    .split("/")
    .filter(Boolean);
  const pathOf = (n: string) => [...folder, n].map(encodeURIComponent).join("/");
  const path = pathOf(name);
  const auth = { authorization: `Bearer ${token}` };
  if (opts?.retry) {
    for (const n of [name, ...(opts.legacyName && opts.legacyName !== name ? [opts.legacyName] : [])]) {
      const res = await fetch(`${driveBase}/root:/${pathOf(n)}?$select=id,webUrl,file,size`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) continue;
      const prev: any = await (await check(res, `buscar exportación previa en ${what}`)).json();
      if (prev?.file && Number(prev.size) === bytes.length && graphSameContent(prev, bytes)) return prev;
    }
  }
  // Renovación del sello: nueva versión del archivo de la exportación anterior (mismo nombre), no una copia «(1)».
  const conflict = opts?.replace ? "replace" : "rename";
  let item: any;
  if (bytes.length <= 4 * 1024 * 1024) {
    item = await (
      await check(
        await fetch(`${driveBase}/root:/${path}:/content?@microsoft.graph.conflictBehavior=${conflict}`, {
          method: "PUT",
          headers: { ...auth, "content-type": contentType },
          body: Buffer.from(bytes),
          signal: AbortSignal.timeout(60_000),
        }),
        `subir a ${what}`,
      )
    ).json();
  } else {
    // Archivos grandes: sesión de carga en partes de 5 MiB (múltiplo de 320 KiB).
    const session: any = await (
      await check(
        await fetch(`${driveBase}/root:/${path}:/createUploadSession`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": conflict } }),
          signal: AbortSignal.timeout(15_000),
        }),
        `sesión de carga ${what}`,
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
      await check(r, `parte ${what}`);
      if (end === bytes.length) item = await r.json();
    }
  }
  return item;
}

// ───── Box ─────

/** Busca o crea cada segmento de la carpeta en Box. Ante un 409 (ya existe) usa el id que informa Box. */
export async function ensureBoxFolder(token: string, folder: string): Promise<string> {
  let parent = "0";
  for (const seg of folder
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const res = await fetch(`${BOX_API()}/2.0/folders?fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: seg.slice(0, 255), parent: { id: parent } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409) {
      const b: any = await res.json().catch(() => ({}));
      const c = b?.context_info?.conflicts;
      const id = Array.isArray(c) ? c[0]?.id : c?.id;
      if (!id) throw new Error("crear carpeta en Box: HTTP 409 sin el id de la carpeta existente");
      parent = String(id);
      continue;
    }
    parent = String(((await (await check(res, "crear carpeta en Box")).json()) as any).id);
  }
  return parent;
}

export async function uploadBox(
  creds: OAuthCreds,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const { token, updated } = await freshToken("box", creds, onRefresh);
  let folderId: string = cfg.folderId ?? "";
  const newCfg: Record<string, unknown> = {};
  if (!folderId) {
    folderId = cfg.folder ? await ensureBoxFolder(token, String(cfg.folder)) : "0";
    newCfg.folderId = folderId;
  }
  const put = async (fileName: string) => {
    const form = new FormData();
    form.append("attributes", JSON.stringify({ name: fileName, parent: { id: folderId } }));
    form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }), fileName);
    return fetch(`${BOX_UPLOAD()}/api/2.0/files/content?fields=id,name`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  };
  let res = await put(name);
  // La carpeta fijada ya no existe (se borró o se movió a la papelera en Box): se vuelve a buscar/crear una vez. Sin
  // esto, todas las exportaciones de la conexión fallaban con 404 hasta cambiar la carpeta a mano.
  if (res.status === 404 && cfg.folderId && cfg.folder) {
    folderId = await ensureBoxFolder(token, String(cfg.folder));
    newCfg.folderId = folderId;
    res = await put(name);
  }
  // Nombre ocupado (409 item_name_in_use). Box informa el archivo existente (context_info.conflicts, con su sha1): si son
  // los mismos bytes es lo que subió un intento anterior que falló después (o murió antes de anotarlo) y se reutiliza;
  // si no, Box no renombra solo y se agrega un sufijo.
  if (res.status === 409) {
    const b: any = await res.json().catch(() => ({}));
    const c = b?.context_info?.conflicts;
    const existing = Array.isArray(c) ? c[0] : c;
    if (existing?.id && typeof existing.sha1 === "string" && existing.sha1.toLowerCase() === createHash("sha1").update(bytes).digest("hex")) {
      return { ref: `box:${existing.id}`, creds: updated ?? undefined, config: Object.keys(newCfg).length ? newCfg : undefined };
    }
    // Renovación del sello: nueva versión del archivo de la exportación anterior (Box guarda la vieja), no otra copia.
    if (opts?.replace && existing?.id) {
      const form = new FormData();
      form.append("attributes", JSON.stringify({ name }));
      form.append("file", new Blob([Buffer.from(bytes)], { type: contentType }), name);
      const v = await fetch(`${BOX_UPLOAD()}/api/2.0/files/${encodeURIComponent(String(existing.id))}/content?fields=id,name`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const vb = (await (await check(v, "subir versión a Box")).json()) as { id?: string; entries?: { id?: string }[] };
      const vf = vb?.entries?.[0] ?? vb;
      return { ref: `box:${vf?.id ?? existing.id}`, creds: updated ?? undefined, config: Object.keys(newCfg).length ? newCfg : undefined };
    }
    res = await put(name.replace(/(\.[a-z0-9]+)$/i, ` (${Date.now().toString(36)})$1`));
  }
  const body: any = await (await check(res, "subir a Box")).json();
  const file = body?.entries?.[0] ?? body;
  return { ref: `box:${file?.id ?? name}`, creds: updated ?? undefined, config: Object.keys(newCfg).length ? newCfg : undefined };
}

interface S3Creds {
  accessKeyId: string;
  secretAccessKey: string;
}

async function uploadS3(creds: S3Creds, cfg: any, name: string, bytes: Uint8Array, contentType: string): Promise<UploadResult> {
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
    await client.send(new m.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: bytes, ContentType: contentType }), {
      abortSignal: AbortSignal.timeout(120_000),
    });
  } finally {
    client.destroy();
  }
  return { ref: `s3://${cfg.bucket}/${key}` };
}

async function uploadTo(
  provider: StorageProvider,
  credsEnc: string,
  cfg: any,
  name: string,
  bytes: Uint8Array,
  contentType = "application/pdf",
  onRefresh?: OnRefresh,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const creds = JSON.parse(decrypt(credsEnc));
  if (provider === "gdrive") return uploadGdrive(creds, cfg, name, bytes, contentType, onRefresh, opts);
  if (provider === "dropbox") return uploadDropbox(creds, cfg, name, bytes, contentType, onRefresh, opts);
  if (provider === "onedrive") return uploadOnedrive(creds, cfg, name, bytes, contentType, onRefresh, opts);
  if (provider === "sharepoint") return uploadSharepoint(creds, cfg, name, bytes, contentType, onRefresh, opts);
  if (provider === "box") return uploadBox(creds, cfg, name, bytes, contentType, onRefresh, opts);
  return uploadS3(creds, cfg, name, bytes, contentType);
}

const persistCreds =
  (db: Db, connId: string): OnRefresh =>
  async (creds) => {
    await db.query(`UPDATE storage_connections SET credentials_enc = $2, updated_at = now() WHERE id = $1`, [connId, encrypt(JSON.stringify(creds))]);
  };

/**
 * Guarda lo que devolvió la subida. La configuración (id de la carpeta resuelta) solo si la conexión sigue apuntando a la
 * carpeta con la que se subió (`folder`): si alguien la cambió mientras tanto (PATCH, que borra folderId), un id de la
 * carpeta vieja no puede quedar fijado para la nueva.
 */
export async function persistUpload(db: Db, connId: string, r: UploadResult, folder: unknown) {
  if (r.creds)
    await db.query(`UPDATE storage_connections SET credentials_enc = $2, updated_at = now() WHERE id = $1`, [
      connId,
      encrypt(JSON.stringify(r.creds)),
    ]);
  if (r.config) {
    await db.query(
      `UPDATE storage_connections SET config = config || $2::jsonb, updated_at = now() WHERE id = $1 AND COALESCE(config->>'folder', '') = $3`,
      [connId, JSON.stringify(r.config), String(folder ?? "")],
    );
  }
}

const fileName = (subject: string, envelopeId: string) => `${safeBaseName(subject, envelopeId)}.pdf`;
const legacyFileName = (subject: string, envelopeId: string) => `${legacySafeBaseName(subject, envelopeId)}.pdf`;

// ───────────────────────────── Job de exportación ─────────────────────────────

/**
 * ¿La copia subida es la del PDF vigente del sobre? Una renovación del sello de archivo cambia el PDF (y su sha256):
 * la copia anterior queda con el sello que vence. Sin sha anotado (exportaciones anteriores a 0057) se da por vigente;
 * la renovación las marca con '' para que no pasen por vigentes (queueStorageReexports).
 */
const exportIsCurrent = (ex: { pdf_sha256: string | null }, signedSha: string | null) =>
  ex.pdf_sha256 === null || signedSha === null || ex.pdf_sha256 === signedSha;

export async function exportEnvelopeJob(db: Db, blobs: BlobStore, p: { connectionId: string; envelopeId: string }) {
  const c = await db.one<any>(`SELECT * FROM storage_connections WHERE id = $1`, [p.connectionId]);
  let ex = await db.one<any>(`SELECT * FROM storage_exports WHERE connection_id = $1 AND envelope_id = $2`, [p.connectionId, p.envelopeId]);
  if (!c || !ex) return;
  const e = await db.one<any>(
    `SELECT e.subject, e.status, f.storage_key, f.sha256 FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [p.envelopeId],
  );
  if (ex.status === "succeeded") {
    if (!e || e.status !== "completed" || exportIsCurrent(ex, e.sha256)) return;
    // Exportada con un PDF anterior a una renovación del sello: se vuelve a subir. Condicionado al sha leído: si otro
    // trabajo ya la reabrió (o la volvió a subir), este no la pisa.
    const reopened = await db.query(
      `UPDATE storage_exports SET status = 'pending', pdf_ref = NULL, pdf_sha256 = NULL, error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'succeeded' AND pdf_sha256 IS NOT DISTINCT FROM $2 RETURNING id`,
      [ex.id, ex.pdf_sha256],
    );
    if (!reopened.length) return;
    ex = { ...ex, status: "pending", pdf_ref: null, pdf_sha256: null, error: null };
  }
  if (!c.active) {
    await db.query(`UPDATE storage_exports SET status = 'failed', error = 'conexión desactivada', updated_at = now() WHERE id = $1`, [ex.id]);
    return;
  }
  if (!e || e.status !== "completed") return;
  // Reclamo con vencimiento (por si el proceso muere a mitad): si otro trabajo ya la está subiendo, este no hace nada.
  // El valor del reclamo identifica a este intento (como texto: un Date de JS pierde los microsegundos): al terminar se
  // suelta solo si sigue siendo el suyo. Uno que tardó más que el reclamo no borra el del intento que tomó la posta.
  const claimed = await db.query<{ id: string; attempts: number; until: string }>(
    `UPDATE storage_exports SET claimed_until = clock_timestamp() + interval '15 minutes', attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND status <> 'succeeded' AND (claimed_until IS NULL OR claimed_until < now()) RETURNING id, attempts, claimed_until::text AS until`,
    [ex.id],
  );
  if (!claimed.length) {
    const cur = await db.one<any>(`SELECT status FROM storage_exports WHERE id = $1`, [ex.id]);
    if (!cur || cur.status === "succeeded") return;
    // Otro trabajo la tiene tomada (o uno que murió, hasta que venza el reclamo): se reintenta más tarde con la cola.
    // Terminar sin error dejaba la exportación 'pending' para siempre si el que la tenía se había caído.
    throw new Error("exportación en curso en otro trabajo; se reintenta");
  }
  try {
    // Desde el segundo intento, la subida evita duplicar lo que un intento anterior pudo haber dejado.
    await runExport(db, blobs, p, c, ex, e, Number(claimed[0].attempts) > 1);
  } finally {
    await db.query(`UPDATE storage_exports SET claimed_until = NULL WHERE id = $1 AND claimed_until = $2::timestamptz`, [ex.id, claimed[0].until]);
  }
}

async function runExport(db: Db, blobs: BlobStore, p: { connectionId: string; envelopeId: string }, c: any, ex: any, e: any, retry: boolean) {
  try {
    let cur = await withResolvedFolder(db, c);
    // El PDF ya subido en un intento anterior (falló solo el certificado de evidencia) no se vuelve a subir.
    // Si entre medio una renovación del sello cambió el PDF, el subido ya no sirve: se sube el vigente.
    const prev = await db.one<any>(`SELECT pdf_ref, pdf_sha256 FROM storage_exports WHERE id = $1`, [ex.id]);
    if (prev?.pdf_ref && !exportIsCurrent(prev, e.sha256 ?? null)) prev.pdf_ref = null;
    let ref: string = prev?.pdf_ref ?? null;
    // Ya hubo una exportación completa (remote_ref) y ahora se vuelve a subir: es la de una renovación del sello.
    const replace = ex.remote_ref ? { ref: String(ex.remote_ref) } : null;
    let pdfSha: string | null = prev?.pdf_ref ? (prev.pdf_sha256 ?? null) : null;
    if (!ref) {
      const bytes = await blobs.get(e.storage_key);
      const r = await uploadTo(
        cur.provider,
        cur.credentials_enc,
        cur.config ?? {},
        fileName(e.subject, p.envelopeId),
        bytes,
        "application/pdf",
        persistCreds(db, c.id),
        {
          envelopeId: p.envelopeId,
          kind: "pdf",
          retry,
          legacyName: legacyFileName(e.subject, p.envelopeId),
          ...(replace ? { replace } : {}),
        },
      );
      await persistUpload(db, c.id, r, cur.config?.folder);
      ref = r.ref;
      pdfSha = e.sha256 ?? null;
      await db.query(`UPDATE storage_exports SET pdf_ref = $2, pdf_sha256 = $3, updated_at = now() WHERE id = $1`, [ex.id, ref, pdfSha]);
    }
    if (c.config?.includeEvidence) {
      // Con la fila releída: la subida del PDF pudo renovar el token o fijar la carpeta.
      cur = (await db.one<any>(`SELECT * FROM storage_connections WHERE id = $1`, [c.id])) ?? cur;
      // Describe el PDF que se subió (si una renovación del sello cambió el PDF entre medio, no el nuevo).
      const ev = await evidenceCertificate(db, p.envelopeId, { signedSha256: pdfSha });
      const r2 = await uploadTo(
        cur.provider,
        cur.credentials_enc,
        cur.config ?? {},
        `${safeBaseName(e.subject, p.envelopeId)} - evidencia.json`,
        ev,
        "application/json",
        persistCreds(db, c.id),
        {
          envelopeId: p.envelopeId,
          kind: "evidence",
          retry,
          legacyName: `${legacySafeBaseName(e.subject, p.envelopeId)} - evidencia.json`,
          ...(replace ? { replace } : {}),
        },
      );
      await persistUpload(db, c.id, r2, cur.config?.folder);
    }
    await db.query(`UPDATE storage_exports SET status = 'succeeded', remote_ref = $2, error = NULL, updated_at = now() WHERE id = $1`, [ex.id, ref]);
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

/**
 * Al renovarse el sello de archivo: las copias ya exportadas se vuelven a subir con el PDF renovado (si no, quedaban
 * con el sello que vence). Solo las de conexiones activas que ya tenían este sobre. El trabajo decide por el sha256
 * (exportEnvelopeJob), así que una subida del PDF anterior todavía en curso no la deja como vigente. Clave por
 * renovación (seq del evento), no permanente: la de la exportación original ya se usó.
 */
export async function queueStorageReexports(db: Db, tenantId: string, envelopeId: string, seq: number) {
  // Las anteriores a 0057 no tienen sha: '' para que no pasen por vigentes.
  const rows = await db.query<{ connection_id: string }>(
    `UPDATE storage_exports x SET pdf_sha256 = COALESCE(x.pdf_sha256, '') FROM storage_connections c
      WHERE c.id = x.connection_id AND c.active AND x.tenant_id = $1 AND x.envelope_id = $2 RETURNING x.connection_id`,
    [tenantId, envelopeId],
  );
  for (const r of rows) {
    await enqueue(
      db,
      "platform",
      { kind: "export", connectionId: r.connection_id, envelopeId },
      { dedupeKey: `exp:${r.connection_id}:${envelopeId}:renewal:${seq}` },
    );
  }
}

// ───────────────────────────── API ─────────────────────────────

function targetOf(r: any): string {
  const cfg = r.config ?? {};
  if (r.provider === "s3") return `${cfg.bucket}/${cfg.prefix ?? ""}`;
  if (r.provider === "sharepoint") return `${cfg.siteUrl ?? ""} › ${cfg.driveName ?? cfg.library ?? ""}/${cfg.folder ?? ""}`;
  return cfg.folder ? String(cfg.folder) : "/";
}

const toApi = (r: any): StorageConnection => ({
  id: r.id,
  provider: r.provider,
  name: r.name,
  target: targetOf(r),
  accountLabel: r.account_label,
  active: r.active,
  includeEvidence: Boolean(r.config?.includeEvidence),
  createdAt: iso(r.created_at)!,
  // Quién la conectó: las OAuth exportan a SU cuenta (al sacarla de la organización se desactivan).
  createdBy: r.created_by
    ? { id: r.created_by, name: r.created_by_name ?? null, email: r.created_by_email ?? null, member: Boolean(r.created_by_member) }
    : null,
  deactivatedReason: r.deactivated_reason === STORAGE_CREATOR_REMOVED ? STORAGE_CREATOR_REMOVED : null,
  lastSuccessAt: iso(r.last_success_at),
  lastError: r.last_error,
});

/** Conexiones con quién las conectó (nombre, correo y si sigue en la organización). */
const CONN_SELECT = `SELECT c.*, u.name AS created_by_name, u.email AS created_by_email,
    EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.created_by) AS created_by_member
  FROM storage_connections c LEFT JOIN users u ON u.id = c.created_by`;

/**
 * Job del aviso: se desactivaron conexiones OAuth porque quien las conectó dejó la organización (deactivateMemberStorage).
 * A propietarios y administradores, con los nombres de las conexiones y de la persona.
 */
export async function notifyStorageMemberRemoved(
  db: Db,
  p: { tenantId: string; userId: string; connectionIds: string[] },
  job?: { id?: number },
  log?: { error(o: object, m?: string): void; warn?(o: object, m?: string): void },
) {
  const conns = await db.query<{ name: string; provider: string }>(
    `SELECT name, provider FROM storage_connections WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deactivated_reason = $3 ORDER BY name`,
    [p.tenantId, p.connectionIds, STORAGE_CREATOR_REMOVED],
  );
  if (!conns.length) return;
  const u = await db.one<{ name: string | null; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [p.userId]);
  const who = u ? (u.name ? `${u.name} <${u.email}>` : u.email) : "?";
  const list = conns.map((c) => `- ${c.name} (${PROVIDER_LABEL[c.provider] ?? c.provider})`).join("\n");
  const link = `${await tenantBaseUrl(db, p.tenantId)}/app/settings/storage`;
  const r = await alertTenantAdmins(db, p.tenantId, "storage_member_removed", (L, c) => MEMBER_REMOVED_ALERT[L](c.product, c.name, who, list, link), {
    jobId: job?.id,
    log,
  });
  // Con un envío transitorio fallido se reintenta aunque otros hayan salido: la deduplicación por job (sendTracked con
  // jobId) no repite los ya enviados.
  if (r.transient.length) throw new Error(`no se pudo avisar la desactivación del almacenamiento: ${r.transient.join("; ")}`);
}

const PROVIDER_LABEL: Record<string, string> = {
  gdrive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  box: "Box",
  s3: "S3",
};

const MEMBER_REMOVED_ALERT: Record<
  AlertLocale,
  (p: string, name: string, who: string, list: string, link: string) => { subject: string; text: string }
> = {
  es: (p, name, who, list, link) => ({
    subject: `${p}: se desactivaron conexiones de almacenamiento de una persona que dejó la organización`,
    text:
      `Hola ${name}:\n\n${who} ya no es parte de la organización. Estas conexiones de almacenamiento las había conectado con su propia cuenta ` +
      `y se desactivaron para que los documentos firmados dejen de copiarse ahí:\n\n${list}\n\n` +
      `Para seguir exportando, conectá de nuevo el almacenamiento con una cuenta de la organización en ${link}\n\n— ${p}`,
  }),
  en: (p, name, who, list, link) => ({
    subject: `${p}: storage connections of a person who left the organization were deactivated`,
    text:
      `Hi ${name},\n\n${who} is no longer part of the organization. These storage connections had been connected with their own account ` +
      `and were deactivated so signed documents are no longer copied there:\n\n${list}\n\n` +
      `To keep exporting, connect the storage again with an organization account at ${link}\n\n— ${p}`,
  }),
  "pt-BR": (p, name, who, list, link) => ({
    subject: `${p}: conexões de armazenamento de uma pessoa que saiu da organização foram desativadas`,
    text:
      `Olá ${name},\n\n${who} não faz mais parte da organização. Estas conexões de armazenamento tinham sido feitas com a conta pessoal dessa pessoa ` +
      `e foram desativadas para que os documentos assinados deixem de ser copiados para lá:\n\n${list}\n\n` +
      `Para continuar exportando, conecte o armazenamento novamente com uma conta da organização em ${link}\n\n— ${p}`,
  }),
};

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
  /** SharePoint: sitio y biblioteca. */
  s?: string;
  l?: string;
  /** Subir también el certificado de evidencia. */
  ev?: boolean;
  exp: number;
}

export async function storageRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const load = async (tenantId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Conexión");
    const r = await s.db.one<any>(`${CONN_SELECT} WHERE c.id = $1 AND c.tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound("Conexión");
    return r;
  };

  // Tope por organización (como los webhooks): cada conexión vuelve a subir el PDF firmado de cada sobre completado, y miles
  // de conexiones llenaban la cola compartida con trabajos de una sola organización.
  const MAX_CONNECTIONS = 20;
  const tooManyConnections = async (tenantId: string) =>
    ((await s.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM storage_connections WHERE tenant_id = $1`, [tenantId]))?.n ?? 0) >=
    MAX_CONNECTIONS;
  const assertConnectionQuota = async (tenantId: string) => {
    if (await tooManyConnections(tenantId))
      throw badRequest("too_many_connections", `Máximo ${MAX_CONNECTIONS} conexiones de almacenamiento por organización`);
  };
  /**
   * Inserta la conexión con la organización bloqueada y el tope contado de nuevo: el chequeo previo queda lejos del
   * insert (prueba de escritura, intercambio de tokens) y conexiones en paralelo pasaban el tope.
   */
  const insertConnection = (tenantId: string, sql: string, params: unknown[]) =>
    s.db.tx(async (t) => {
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      const n = (await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM storage_connections WHERE tenant_id = $1`, [tenantId]))?.n ?? 0;
      if (n >= MAX_CONNECTIONS) throw badRequest("too_many_connections", `Máximo ${MAX_CONNECTIONS} conexiones de almacenamiento por organización`);
      await t.query(sql, params);
    });

  app.get("/v1/storage/providers", { preHandler: auth }, async () => {
    const items: StorageProviderInfo[] = STORAGE_PROVIDERS.map((p) => ({ provider: p, configured: isConfigured(p) }));
    return { items };
  });

  app.get("/v1/storage/connections", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`${CONN_SELECT} WHERE c.tenant_id = $1 ORDER BY c.created_at DESC`, [req.auth!.tenantId]);
    return { items: rows.map(toApi) };
  });

  app.post("/v1/storage/connections/s3", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const input = CreateS3ConnectionInput.parse(req.body);
    await assertConnectionQuota(a.tenantId);
    const endpoint = validateS3Endpoint(input.endpoint);
    const prefix = input.prefix && !input.prefix.endsWith("/") ? `${input.prefix}/` : (input.prefix ?? "");
    const cfg = {
      endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix,
      forcePathStyle: input.forcePathStyle,
      includeEvidence: Boolean(input.includeEvidence),
    };
    const credsEnc = encrypt(JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }));
    // Prueba de escritura antes de guardar: así un error de credenciales se ve ahora y no al completar un sobre.
    try {
      await uploadTo("s3", credsEnc, cfg, "calasign-connection-test.pdf", Buffer.from("%PDF-1.4\n% CalaSign: prueba de conexión\n"));
    } catch (err) {
      throw badRequest("storage_test_failed", `No se pudo escribir en el bucket: ${String((err as Error).message ?? err).slice(0, 300)}`);
    }
    const id = uuidv7();
    await insertConnection(
      a.tenantId,
      `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, account_label, created_by, last_success_at)
       VALUES ($1,$2,'s3',$3,$4,$5,$6,$7, now())`,
      [id, a.tenantId, input.name, JSON.stringify(cfg), credsEnc, `${input.accessKeyId.slice(0, 4)}… @ ${new URL(endpoint).host}`, a.userId],
    );
    await auditFromRequest(s.db, req, a, "storage.connected", {
      targetType: "storage_connection",
      targetId: id,
      data: { provider: "s3", name: input.name, bucket: input.bucket },
    });
    reply.code(201);
    return toApi(await load(a.tenantId, id));
  });

  app.post<{ Params: { provider: string } }>("/v1/storage/oauth/:provider/start", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const p = req.params.provider as OAuthProvider;
    if (!["gdrive", "dropbox", "onedrive", "sharepoint", "box"].includes(p)) throw notFound("Proveedor");
    if (!isConfigured(p)) throw new AppError(409, "provider_not_configured", "Este proveedor no está configurado en el servidor");
    if (!a.userId) throw new AppError(403, "session_required", "Conectar una cuenta requiere iniciar sesión en la web");
    await assertConnectionQuota(a.tenantId);
    const input = ConnectStorageOAuthInput.parse(req.body ?? {});
    if (p === "sharepoint") {
      if (!input.siteUrl) throw badRequest("site_required", "Indicá la URL del sitio de SharePoint");
      parseSharepointSite(input.siteUrl);
    }
    const state: OAuthState = {
      t: a.tenantId,
      u: a.userId,
      p,
      n: input.name,
      f: input.folder ?? "",
      s: p === "sharepoint" ? input.siteUrl : undefined,
      l: p === "sharepoint" ? input.library : undefined,
      ev: Boolean(input.includeEvidence),
      exp: Date.now() + 10 * 60_000,
    };
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
      // Los mismos permisos que pide el resto de /v1/storage para escribir (access.ts): la conexión recibe los PDF firmados
      // de todos los sobres. Quien perdió envelopes:view_all entre el inicio y la vuelta no la crea.
      if (!hasPerm(a, "settings:manage") || !hasPerm(a, "envelopes:view_all")) return back("error=forbidden");
      if (req.query.error || !req.query.code) return back(`error=${encodeURIComponent(req.query.error ?? "no_code")}`);
      if (await tooManyConnections(a.tenantId)) return back("error=too_many_connections");
      // Tokens ya obtenidos: si después no se guarda la conexión, se revocan (si no, el acceso quedaba concedido sin uso).
      let obtained: OAuthCreds | null = null;
      let obtainedLabel: string | null = null;
      let obtainedSub: string | null = null;
      const revokeObtained = async () => {
        if (!obtained) return;
        // Google: los tokens nuevos son de la misma concesión que los de otra conexión con esa cuenta; revocarlos la
        // cortaba también (ver googleGrantShared).
        if (
          st.p === "gdrive" &&
          (await googleGrantShared(s.db, { sub: obtainedSub, label: obtainedLabel, tenantId: a.tenantId, createdBy: a.userId }, null).catch(
            () => true,
          ))
        )
          return;
        const r = await revokeProviderToken(st.p, obtained);
        if (!r.ok) req.log.warn({ provider: st.p, err: r.error }, "no se pudo revocar el acceso obtenido para una conexión que no se guardó");
      };
      try {
        const body = await tokenRequest(st.p, { grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri(st.p) });
        const creds: OAuthCreds = {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000,
        };
        obtained = creds;
        const label = await accountLabel(st.p, body);
        obtainedLabel = label;
        const sub = st.p === "gdrive" ? googleSub(body) : null;
        obtainedSub = sub;
        const cfg: Record<string, unknown> = { folder: st.f, includeEvidence: Boolean(st.ev) };
        if (st.p === "sharepoint") {
          try {
            const d = await resolveSharepointDrive(body.access_token, String(st.s ?? ""), st.l || null);
            Object.assign(cfg, { siteUrl: st.s, library: st.l ?? null, siteId: d.siteId, driveId: d.driveId, driveName: d.driveName });
          } catch (err) {
            req.log.warn({ err: String(err) }, "no se pudo resolver el sitio de SharePoint");
            await revokeObtained();
            return back("error=sharepoint_site");
          }
        }
        const id = uuidv7();
        await insertConnection(
          a.tenantId,
          `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, account_label, created_by, account_sub) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, a.tenantId, st.p, st.n, JSON.stringify(cfg), encrypt(JSON.stringify(creds)), label, a.userId, sub],
        );
        await auditFromRequest(s.db, req, a, "storage.connected", {
          targetType: "storage_connection",
          targetId: id,
          data: { provider: st.p, name: st.n },
        });
        return back(`connected=${st.p}`);
      } catch (err) {
        await revokeObtained();
        if (err instanceof AppError && err.code === "too_many_connections") return back("error=too_many_connections");
        req.log.warn({ err: String(err) }, "no se pudo conectar el almacenamiento");
        return back("error=token_exchange_failed");
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/storage/connections/:id", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    const input = UpdateStorageConnectionInput.parse(req.body);
    // Desactivada porque quien la conectó dejó la organización: exporta a la cuenta personal de esa persona. No se
    // reactiva; hay que conectar el almacenamiento de nuevo con una cuenta de la organización.
    if (input.active === true && r.deactivated_reason === STORAGE_CREATOR_REMOVED) {
      throw new AppError(
        409,
        "storage_reconnect_required",
        "Quien conectó esta cuenta ya no es parte de la organización: conectá el almacenamiento de nuevo",
      );
    }
    const cfgPatch: Record<string, unknown> = {};
    if (input.folder !== undefined && r.provider !== "s3") {
      cfgPatch.folder = input.folder;
      cfgPatch.folderId = null; // Drive y Box: se vuelve a buscar/crear la carpeta
    }
    if (input.includeEvidence !== undefined) cfgPatch.includeEvidence = input.includeEvidence;
    if (input.prefix !== undefined && r.provider === "s3")
      cfgPatch.prefix = input.prefix && !input.prefix.endsWith("/") ? `${input.prefix}/` : input.prefix;
    // La condición se vuelve a mirar en el UPDATE: si la persona deja la organización entre la lectura y la escritura
    // (deactivateMemberStorage), no se reactiva una conexión recién desactivada.
    const upd = await s.db.query(
      `UPDATE storage_connections SET name = COALESCE($2, name), active = COALESCE($3, active), config = config || $4::jsonb, updated_at = now()
        WHERE id = $1 AND NOT ($3::boolean IS TRUE AND deactivated_reason IS NOT DISTINCT FROM $5::text)
        RETURNING id`,
      [r.id, input.name ?? null, input.active ?? null, JSON.stringify(cfgPatch), STORAGE_CREATOR_REMOVED],
    );
    if (!upd.length) {
      // Sin fila actualizada: se desactivó por la baja de quien la conectó (409) o se eliminó (404, como load).
      if (await s.db.one<any>(`SELECT 1 AS x FROM storage_connections WHERE id = $1`, [r.id])) {
        throw new AppError(
          409,
          "storage_reconnect_required",
          "Quien conectó esta cuenta ya no es parte de la organización: conectá el almacenamiento de nuevo",
        );
      }
      throw notFound("Conexión");
    }
    const updated = await load(a.tenantId, r.id);
    // Pausar una conexión, cambiar la carpeta/prefijo de destino o dejar de exportar la evidencia cambia a dónde van (o si
    // van) los documentos firmados: queda en la auditoría con el valor anterior y el nuevo.
    const view = (x: any) => {
      const cfg = (typeof x.config === "string" ? JSON.parse(x.config) : x.config) ?? {};
      return {
        name: x.name,
        active: Boolean(x.active),
        folder: cfg.folder ?? null,
        prefix: cfg.prefix ?? null,
        includeEvidence: Boolean(cfg.includeEvidence),
      };
    };
    const diff = changedValues(view(r), view(updated));
    await auditFromRequest(s.db, req, a, "storage.updated", {
      targetType: "storage_connection",
      targetId: r.id,
      data: { provider: r.provider, changed: diff.changed, from: diff.from, to: diff.to },
    });
    return toApi(updated);
  });

  app.delete<{ Params: { id: string } }>("/v1/storage/connections/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    const del = await s.db.query(`DELETE FROM storage_connections WHERE id = $1 RETURNING id`, [r.id]);
    await auditFromRequest(s.db, req, a, "storage.disconnected", {
      targetType: "storage_connection",
      targetId: r.id,
      data: { provider: r.provider, name: r.name },
    });
    // Lo mejor posible, después de borrarla: que la app deje de tener acceso a esa cuenta en el proveedor.
    if (del.length)
      await revokeStoredCreds(s.db, r.provider, r.credentials_enc, req.log, r.id, {
        sub: r.account_sub ?? null,
        label: r.account_label ?? null,
        tenantId: r.tenant_id,
        createdBy: r.created_by ?? null,
      }).catch((err) => req.log.warn({ err: String(err) }, "no se pudo revocar el acceso de la conexión de almacenamiento"));
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    "/v1/storage/connections/:id/test",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" }, rateLimitByCredential: true } },
    async (req) => {
      const a = req.auth!;
      let r = await load(a.tenantId, req.params.id);
      try {
        r = await withResolvedFolder(s.db, r);
        const res = await uploadTo(
          r.provider,
          r.credentials_enc,
          r.config ?? {},
          "calasign-connection-test.pdf",
          Buffer.from("%PDF-1.4\n% CalaSign: prueba de conexión\n"),
          "application/pdf",
          persistCreds(s.db, r.id),
        );
        await persistUpload(s.db, r.id, res, r.config?.folder);
        await s.db.query(`UPDATE storage_connections SET last_success_at = now(), last_error = NULL WHERE id = $1`, [r.id]);
        return { ok: true, ref: res.ref, error: null };
      } catch (err) {
        const msg = String((err as Error).message ?? err).slice(0, 300);
        await s.db.query(`UPDATE storage_connections SET last_error = $2 WHERE id = $1`, [r.id, msg]);
        return { ok: false, ref: null, error: msg };
      }
    },
  );

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
    // Solo una fallida: una pendiente ya está en la cola (o subiéndose), y un segundo trabajo subía el PDF dos veces.
    const upd = await s.db.query(
      // También una pendiente abandonada (sin reclamo vigente y sin cambios en 15 minutos: el trabajo murió).
      `UPDATE storage_exports SET status = 'pending', error = NULL, updated_at = now()
        WHERE id = $1 AND (status = 'failed' OR (status = 'pending' AND (claimed_until IS NULL OR claimed_until < now()) AND updated_at < now() - interval '15 minutes'))
        RETURNING id`,
      [x.id],
    );
    if (!upd.length) throw new AppError(409, "export_in_progress", "La exportación ya está en curso");
    await enqueue(
      s.db,
      "platform",
      { kind: "export", connectionId: x.connection_id, envelopeId: x.envelope_id },
      { dedupeKey: `exp:${x.connection_id}:${x.envelope_id}:${Date.now()}` },
    );
    reply.code(202);
    return { queued: true };
  });
}
