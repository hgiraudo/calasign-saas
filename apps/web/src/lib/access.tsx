// Rol, permisos y organizaciones de la sesión (GET /v1/me/access).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AccessResponse, Permission, PlanFeature } from "@calasign/shared";
import { api, FORBIDDEN_EVENT } from "./api";
import { useAuth } from "./auth";
import { useI18n } from "./i18n";

interface AccessCtx {
  access: AccessResponse | null;
  /** La última carga de /v1/me/access de esta sesión falló (y no quedaron permisos anteriores): access sigue en null. */
  failed: boolean;
  can: (p: Permission) => boolean;
  /** ¿El plan de la organización incluye esta función? Mientras carga, sí (la API igual responde 402 plan_limit). */
  hasFeature: (f: PlanFeature) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AccessCtx>({ access: null, failed: false, can: () => true, hasFeature: () => true, refresh: async () => {} });

export function AccessProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  // Los permisos quedan atados a la sesión (organización y usuario) para la que se pidieron: al cambiar de organización
  // no se usan ni en el primer render. Antes se borraban en un efecto, que corre después de dibujar (y después de los
  // efectos de las páginas recién montadas): ese render todavía veía los de la otra organización (p. ej. la que exige
  // 2FA mandaba a Seguridad al pasar a una que no lo exige).
  const key = me ? `${me.tenant.id}:${me.user.id}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [state, setState] = useState<{ key: string | null; access: AccessResponse | null; failed?: boolean }>({ key: null, access: null });
  const access = key !== null && state.key === key ? state.access : null;
  const failed = key !== null && state.key === key && !state.access && Boolean(state.failed);
  // Solo vale la respuesta más reciente: una recarga pedida antes de cambiar de organización no pisa la de la nueva.
  const seq = useRef(0);

  // Último pedido de /v1/me/access: las recargas automáticas (403, volver a la pestaña) se espacian.
  const lastAt = useRef(0);

  // background: recarga automática (403, volver a la pestaña). Si falla (red caída, 5xx), se conservan los permisos
  // anteriores de la misma sesión: volver a null mostraba todo (mientras carga no se oculta nada) hasta la próxima.
  const load = useCallback(async (background: boolean) => {
    lastAt.current = Date.now();
    const mine = ++seq.current;
    const k = keyRef.current;
    try {
      const a = await api<AccessResponse>("/v1/me/access");
      if (mine === seq.current) setState({ key: k, access: a });
    } catch {
      if (mine === seq.current) setState((prev) => (background && prev.key === k && prev.access ? prev : { key: k, access: null, failed: true }));
    }
  }, []);
  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    if (key) void refresh();
    // Sin sesión, una respuesta todavía en camino no se aplica.
    else seq.current++;
  }, [key, refresh]);

  // Los permisos cambian sin que la consola se entere (otro administrador cambió el rol o recortó el rol): se vuelven
  // a pedir al recibir un 403 forbidden y al volver a la pestaña, como mucho cada 5 s y 30 s respectivamente.
  useEffect(() => {
    if (!key) return;
    const maybe = (minMs: number) => {
      if (Date.now() - lastAt.current >= minMs) void load(true);
    };
    const onForbidden = () => maybe(5_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") maybe(30_000);
    };
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, load]);

  // Mientras carga, no se ocultan cosas (el servidor igual aplica los permisos).
  const can = useCallback((p: Permission) => (access ? access.permissions.includes(p) : true), [access]);
  const hasFeature = useCallback((f: PlanFeature) => (access?.planFeatures ? access.planFeatures.includes(f) : true), [access]);
  return <Ctx.Provider value={{ access, failed, can, hasFeature, refresh }}>{children}</Ctx.Provider>;
}

/**
 * ¿Puede quien está en la sesión administrar a alguien (o un rol, una API key, una app de servicio) con estos permisos?
 * Como la API (assertCanManage / assertCanGrant): un propietario sí; si no, solo si tiene todos esos permisos. Sin datos
 * todavía, no se oculta (la API decide).
 */
export function canManagePerms(access: { role?: string | null; permissions: readonly string[] } | null | undefined, perms: readonly string[] | null | undefined) {
  if (!access || !perms) return true;
  return access.role === "owner" || perms.every((p) => access.permissions.includes(p));
}

/**
 * Aviso de función no incluida en el plan, con link a Facturación. Lo configurado se puede seguir viendo, pausando o
 * quitando (la API lo permite sin el plan); lo que crea o activa algo nuevo se deshabilita en cada página.
 */
export function PlanNotice({ feature, text }: { feature: PlanFeature; text?: string }) {
  const { access, hasFeature, can } = useAccess();
  const { t } = useI18n();
  if (hasFeature(feature)) return null;
  return (
    <div className="hint" role="note">
      {text ?? t("common.notInPlan", { plan: access?.planName ?? "" })}{" "}
      {/* Facturación exige billing:manage: sin el permiso, el link llevaba a un 403. */}
      {can("billing:manage") ? <Link to="/app/settings/billing">{t("common.seePlans")}</Link> : t("common.askAdminPlan")}
    </div>
  );
}

/**
 * Guarda de ruta por permiso: sin él muestra `fallback` (un mensaje claro) en vez de la página, que fallaría con un 403
 * crudo. Mientras cargan los permisos se muestra la página (la API igual los aplica).
 */
export function RequirePermission({ perm, fallback, children }: { perm: Permission; fallback: ReactNode; children: ReactNode }) {
  const { can } = useAccess();
  return <>{can(perm) ? children : fallback}</>;
}

export function useAccess() {
  return useContext(Ctx);
}
