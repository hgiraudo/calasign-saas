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
  const [access, setAccess] = useState<AccessResponse | null>(null);
  // Solo vale la respuesta más reciente: una recarga pedida antes de cambiar de organización no pisa la de la nueva.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const a = await api<AccessResponse>("/v1/me/access");
      if (mine === seq.current) setAccess(a);
    } catch {
      if (mine === seq.current) setAccess(null);
    }
  }, []);

  useEffect(() => {
    // Al cambiar de organización (o de usuario) los permisos de la anterior no siguen vigentes mientras carga la nueva:
    // las páginas se vuelven a montar enseguida (key en Layout) y las que eligen un rol por defecto una sola vez (API
    // keys, apps OAuth, invitaciones) lo calculaban con los permisos de la otra organización.
    setAccess(null);
    if (me) void refresh();
  }, [me?.tenant.id, me?.user.id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mientras carga, no se ocultan cosas (el servidor igual aplica los permisos).
  const can = useCallback((p: Permission) => (access ? access.permissions.includes(p) : true), [access]);
  return <Ctx.Provider value={{ access, can, refresh }}>{children}</Ctx.Provider>;
}

export function useAccess() {
  return useContext(Ctx);
}
