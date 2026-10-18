-- Ronda 17: la re-verificación de dominios propios cuenta los controles fallidos (falta el TXT o el dominio ya no
-- apunta a la plataforma: 2 puntos; error de DNS: 1 punto). Con 4 puntos seguidos el dominio deja de usarse. Antes
-- solo contaba el TXT (que es público y quien se quede con el dominio puede volver a publicar) y un error de DNS
-- nunca contaba, así que un dominio que solo devolvía errores no se desverificaba nunca.
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS recheck_failures integer NOT NULL DEFAULT 0;
