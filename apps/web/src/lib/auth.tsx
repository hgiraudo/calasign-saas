// Sesión del remitente: GET /v1/me.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { MeResponse } from "@calasign/shared";
import { api, errorText, HttpError, isConsolePage, setExpectedSession, TENANT_MISMATCH_EVENT, UNAUTHORIZED_EVENT } from "./api";
import { broadcastSessionChange, onSessionChange } from "./session-sync";
import { confirmUnload, hasUnsavedChanges } from "./i18n";
import { usePasswordText } from "./i18n-password";
import { Modal, Spinner } from "../components/ui";

interface AuthCtx {
  me: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<MeResponse | null>;
  setMe: (m: MeResponse | null) => void;
  logout: () => Promise<void>;
  /** La sesión terminó mientras se usaba la app (no es un logout propio). */
  expired: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  // La sesión venció con un editor con cambios sin guardar: no se cierra (RequireAuth mandaba al login y desmontaba el
  // editor, perdiendo lo cargado); se avisa para ingresar en otra pestaña y seguir.
  const [sessionLost, setSessionLost] = useState(false);
  const meRef = useRef(me);
  meRef.current = me;
  // Organización y cuenta que muestra esta pestaña: van en x-calasign-tenant / x-calasign-user en cada escritura (409
  // tenant_mismatch si la sesión se movió a otra organización o cuenta en otra pestaña). Se fija al renderizar para que
  // el primer pedido después de setMe ya los lleve.
  setExpectedSession(me ? { tenantId: me.tenant.id, userId: me.user.id } : null);
  /** Sesión terminada: al login con aviso, salvo que haya cambios sin guardar (entonces, el aviso sin desmontar). */
  const endSession = useCallback(() => {
    if (meRef.current && hasUnsavedChanges()) {
      setSessionLost(true);
      return;
    }
    if (meRef.current) setExpired(true);
    setMe(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api<MeResponse>("/v1/me");
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Había sesión y ya no: terminó mientras se usaba la app (el login lo avisa).
        endSession();
      } else if (!(e instanceof HttpError) || e.status === 403) {
        setMe(null);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [endSession]);

  // Recarga completa al login (no navegación de la SPA): descarta todo lo que quedó en memoria de la sesión (PDFs y
  // datos cacheados, estado de las páginas) y la página no queda en el historial como una vista con datos. Quien la
  // llama ya confirmó descartar los cambios sin guardar (confirmDiscardUnsaved).
  const logout = useCallback(async () => {
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } finally {
      broadcastSessionChange({ kind: "logout", tenantId: null, userId: null });
      setMe(null);
      confirmUnload();
      window.location.assign("/login");
    }
  }, []);

  // Página restaurada desde el bfcache (botón Atrás después de salir, o de cerrar sesión en otra pestaña): se vuelve a
  // consultar /v1/me; sin sesión, RequireAuth manda al login en vez de mostrar los datos de antes.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void refresh();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Un 401 en cualquier pedido: si había sesión, se revisa /v1/me. Si ya no existe (venció, se cerró en otro lado o
  // la organización pasó a exigir SSO), se marca como vencida y RequireAuth manda al login con un aviso. Antes cada
  // acción fallaba con "Autenticación requerida" y no había forma de seguir sin recargar la página.
  const checking = useRef(false);
  useEffect(() => {
    const onUnauthorized = async () => {
      if (!meRef.current || checking.current) return;
      checking.current = true;
      try {
        await api<MeResponse>("/v1/me");
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) endSession();
      } finally {
        checking.current = false;
      }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [endSession]);
  // La sesión cambió en otra pestaña (aviso entre pestañas, o el servidor respondió 409 tenant_mismatch): esta pestaña
  // muestra otra organización o cuenta y lo que guarde iría a otro lado. Se recarga con un aviso; con cambios sin
  // guardar, solo el aviso (para copiarlos antes de recargar).
  const [staleTab, setStaleTab] = useState(false);
  const [reloadedNotice, setReloadedNotice] = useState(() => {
    try {
      const v = window.sessionStorage.getItem(TAB_RELOAD_FLASH);
      window.sessionStorage.removeItem(TAB_RELOAD_FLASH);
      return v === "1";
    } catch {
      return false;
    }
  });
  const sessionChangedElsewhere = useCallback(() => {
    if (hasUnsavedChanges()) {
      setStaleTab(true);
      return;
    }
    try {
      window.sessionStorage.setItem(TAB_RELOAD_FLASH, "1");
    } catch {
      // sin almacenamiento: se recarga sin el aviso
    }
    window.location.reload();
  }, []);
  useEffect(() => {
    const onMismatch = () => sessionChangedElsewhere();
    window.addEventListener(TENANT_MISMATCH_EVENT, onMismatch);
    const stop = onSessionChange((c) => {
      const cur = meRef.current;
      // Solo la consola: una pestaña de firmante (o de verificación, invitación…) no depende de la sesión.
      if (!cur || !isConsolePage()) return;
      if (c.kind === "logout" || c.tenantId !== cur.tenant.id || (c.userId !== null && c.userId !== cur.user.id)) sessionChangedElsewhere();
    });
    return () => {
      window.removeEventListener(TENANT_MISMATCH_EVENT, onMismatch);
      stop();
    };
  }, [sessionChangedElsewhere]);

  const setMeAndClear = useCallback((m: MeResponse | null) => {
    if (m) setExpired(false);
    setMe(m);
  }, []);

  return (
    <Ctx.Provider value={{ me, loading, refresh, setMe: setMeAndClear, logout, expired }}>
      {children}
      {staleTab && (
        <TabChangedModal
          unsaved
          onClose={() => setStaleTab(false)}
          onReload={() => {
            confirmUnload();
            window.location.reload();
          }}
        />
      )}
      {reloadedNotice && <TabChangedModal onClose={() => setReloadedNotice(false)} />}
      {sessionLost && me && (
        <SessionLostModal
          me={me}
          onRestored={(m) => {
            setSessionLost(false);
            setMeAndClear(m);
          }}
          onDiscard={() => {
            setSessionLost(false);
            setExpired(true);
            setMe(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

const TAB_RELOAD_FLASH = "calasign:tab-reloaded";

/** Aviso de que la sesión cambió en otra pestaña: después de recargar, o (con cambios sin guardar) antes de hacerlo. */
function TabChangedModal({ unsaved, onClose, onReload }: { unsaved?: boolean; onClose: () => void; onReload?: () => void }) {
  const pw = usePasswordText();
  return (
    <Modal
      title={pw("tabChangedTitle")}
      onClose={onClose}
      footer={
        unsaved ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {pw("tabOk")}
            </button>
            <button type="button" className="btn btn-primary" onClick={onReload}>
              {pw("tabReload")}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {pw("tabOk")}
          </button>
        )
      }
    >
      <p>{pw(unsaved ? "tabChangedUnsaved" : "tabChangedBody")}</p>
    </Modal>
  );
}

/**
 * Sesión vencida con cambios sin guardar: se ingresa en otra pestaña (la cookie es la misma) y «Reintentar» vuelve a
 * leer /v1/me. Tiene que ser la misma persona y la misma organización: con otra, los guardados irían a otro lado.
 */
function SessionLostModal({
  me,
  onRestored,
  onDiscard,
}: {
  me: MeResponse;
  onRestored: (m: MeResponse) => void;
  onDiscard: () => void;
}) {
  const pw = usePasswordText();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const m = await api<MeResponse>("/v1/me");
      if (m.user.id === me.user.id && m.tenant.id === me.tenant.id) onRestored(m);
      else setMsg(pw("lostOtherAccount"));
    } catch (e) {
      setMsg(e instanceof HttpError && e.status === 401 ? pw("lostStill") : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={pw("lostTitle")}
      // Cerrar (Esc/X) es lo mismo que «Reintentar»: solo se cierra si /v1/me vuelve con la misma persona y organización.
      // Cerrarlo sin más dejaba seguir guardando con la sesión que hubiera en la cookie (otro usuario de la org, o
      // ninguna, con el aviso de nuevo en el siguiente 401).
      onClose={() => void retry()}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDiscard}>
            {pw("lostDiscard")}
          </button>
          <button type="button" className="btn" onClick={() => window.open("/login", "_blank", "noopener")}>
            {pw("lostLogin")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={retry}>
            {pw("lostRetry")}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>{pw("lostBody")}</p>
        {msg && (
          <div className="alert alert-warn" role="status">
            {msg}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AuthProvider faltante");
  return c;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}
