// Sesión del remitente: GET /v1/me.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { MeResponse } from "@calasign/shared";
import { api, HttpError, UNAUTHORIZED_EVENT } from "./api";
import { Spinner } from "../components/ui";

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
  const meRef = useRef(me);
  meRef.current = me;

  const refresh = useCallback(async () => {
    try {
      const m = await api<MeResponse>("/v1/me");
      setMe(m);
      return m;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status === 401 || e.status === 403) {
        // Había sesión y ya no: terminó mientras se usaba la app (el login lo avisa).
        if (meRef.current && e instanceof HttpError && e.status === 401) setExpired(true);
        setMe(null);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } finally {
      setMe(null);
    }
  }, []);

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
        if (e instanceof HttpError && e.status === 401) {
          setExpired(true);
          setMe(null);
        }
      } finally {
        checking.current = false;
      }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);
  const setMeAndClear = useCallback((m: MeResponse | null) => {
    if (m) setExpired(false);
    setMe(m);
  }, []);

  return <Ctx.Provider value={{ me, loading, refresh, setMe: setMeAndClear, logout, expired }}>{children}</Ctx.Provider>;
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
