-- Huso horario de la organización (IANA, p. ej. America/Argentina/Buenos_Aires). Con él se escriben las horas del
-- certificado de finalización y la fecha de los campos «fecha de firma» del PDF, con el desfase respecto de UTC a la
-- vista; antes todo iba en UTC y el PDF mostraba una hora que no era la de nadie. Lo configura la organización en
-- Ajustes (PATCH /v1/settings/organization); el alta por la web toma el del navegador. Las organizaciones existentes
-- quedan en UTC: su PDF sale igual que antes hasta que lo cambien. Columna con DEFAULT constante: no reescribe la tabla.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'UTC';
