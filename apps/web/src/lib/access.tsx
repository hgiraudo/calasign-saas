// Rol, permisos y organizaciones de la sesión (GET /v1/me/access).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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

  const refresh = useCallback(async () => {
    try {
      setAccess(await api<AccessResponse>("/v1/me/access"));
    } catch {
      setAccess(null);
    }
  }, []);

  useEffect(() => {
    if (me) void refresh();
    else setAccess(null);
  }, [me?.tenant.id, me?.user.id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mientras carga, no se ocultan cosas (el servidor igual aplica los permisos).
  const can = useCallback((p: Permission) => (access ? access.permissions.includes(p) : true), [access]);
  return <Ctx.Provider value={{ access, can, refresh }}>{children}</Ctx.Provider>;
}

export function useAccess() {
  return useContext(Ctx);
}
