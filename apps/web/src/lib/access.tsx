// Rol, permisos y organizaciones de la sesión (GET /v1/me/access).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AccessResponse, Permission } from "@calasign/shared";
import { api } from "./api";
import { useAuth } from "./auth";

interface AccessCtx {
  access: AccessResponse | null;
  can: (p: Permission) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AccessCtx>({ access: null, can: () => true, refresh: async () => {} });

export function AccessProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  // Los permisos quedan atados a la sesión (organización y usuario) para la que se pidieron: al cambiar de organización
  // no se usan ni en el primer render. Antes se borraban en un efecto, que corre después de dibujar (y después de los
  // efectos de las páginas recién montadas): ese render todavía veía los de la otra organización (p. ej. la que exige
  // 2FA mandaba a Seguridad al pasar a una que no lo exige).
  const key = me ? `${me.tenant.id}:${me.user.id}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [state, setState] = useState<{ key: string | null; access: AccessResponse | null }>({ key: null, access: null });
  const access = key !== null && state.key === key ? state.access : null;
  // Solo vale la respuesta más reciente: una recarga pedida antes de cambiar de organización no pisa la de la nueva.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const k = keyRef.current;
    try {
      const a = await api<AccessResponse>("/v1/me/access");
      if (mine === seq.current) setState({ key: k, access: a });
    } catch {
      if (mine === seq.current) setState({ key: k, access: null });
    }
  }, []);

  useEffect(() => {
    if (key) void refresh();
    // Sin sesión, una respuesta todavía en camino no se aplica.
    else seq.current++;
  }, [key, refresh]);

  // Mientras carga, no se ocultan cosas (el servidor igual aplica los permisos).
  const can = useCallback((p: Permission) => (access ? access.permissions.includes(p) : true), [access]);
  return <Ctx.Provider value={{ access, can, refresh }}>{children}</Ctx.Provider>;
}

export function useAccess() {
  return useContext(Ctx);
}
