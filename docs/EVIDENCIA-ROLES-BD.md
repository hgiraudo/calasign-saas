# Evidencia append-only y roles de la base

Las migraciones 0072 y 0074 agregan triggers que hacen append-only los registros de evidencia:

- `envelope_events` (cadena de hashes de cada sobre) y `account_audit_log` (auditoría de la organización) rechazan
  `UPDATE`, `DELETE` y `TRUNCATE`. Excepciones: el `UPDATE` que solo cambia `pos` (secuenciador del feed de eventos) y el
  `DELETE` de los eventos de un sobre en borrador.
- `envelopes` no vuelve a `status = 'draft'` desde otro estado (0074): la excepción de borradores se apoyaba en ese
  estado, y devolver un sobre a borrador habilitaba borrar su evidencia.
- Mantenimiento explícito: `SET LOCAL calasign.allow_evidence_write = 'on'` dentro de la transacción.

## Qué protegen y qué no

Frenan errores de la aplicación (un `UPDATE`/`DELETE` equivocado) y a quien solo tiene DML sobre las tablas (por
ejemplo, una inyección SQL limitada a sentencias de datos con un rol sin propiedad).

**No** frenan a quien tiene el rol dueño de las tablas. Hoy la API se conecta con el mismo rol que corre las
migraciones y es dueño de todo: con ese rol se puede activar `calasign.allow_evidence_write`, hacer
`ALTER TABLE … DISABLE TRIGGER`, o reemplazar/borrar las funciones de los triggers. La cadena de hashes y el hash final
impreso en el certificado del PDF sellado (verificación pública) siguen detectando una reescritura, pero la base sola
no la impide.

## Separación de roles (pendiente, no aplicada)

1. `calasign_owner`: dueño del esquema y de las tablas. Solo lo usan las migraciones (job de despliegue). Sin acceso
   desde la API.
2. `calasign_app`: el rol de la API y los workers. Sin propiedad de tablas ni `CREATE` en el esquema; con
   `SELECT, INSERT, UPDATE, DELETE` sobre las tablas de negocio y `USAGE` sobre las secuencias. Sobre
   `envelope_events` y `account_audit_log`, `SELECT, INSERT` y el `UPDATE (pos)` del secuenciador.
3. El mantenimiento que necesite `calasign.allow_evidence_write` se hace con `calasign_owner`, de forma explícita y
   registrada. Para impedir que `calasign_app` active el ajuste, la verificación del trigger puede además exigir
   `current_user = 'calasign_owner'`.
4. Configuración: `DATABASE_URL` de la API con `calasign_app` y una URL aparte para las migraciones (hoy el runner corre
   al iniciar la API con la misma conexión: habría que moverlo al despliegue).
