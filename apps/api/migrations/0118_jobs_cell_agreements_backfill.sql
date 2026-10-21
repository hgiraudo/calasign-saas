-- Celda de los jobs de la cola "agreements" que llevan solo el id del run, la negociación o el acuerdo (advance,
-- negotiation_notice, proposal_notice, workflow_approval_notice, expiry_notice): 0115 los dejó en NULL (cualquier
-- worker) porque buscaba solo payload.tenantId / payload.envelopeId. Los pendientes o en curso toman la celda de su
-- organización. Los ids viejos ('local', 'dev') quedan NULL, como en 0115.
UPDATE jobs j SET cell = x.cell
  FROM (
    SELECT j2.id, COALESCE(d.cell, t.cell) AS cell
      FROM jobs j2
      JOIN tenants t ON t.id = COALESCE(
        (SELECT r.tenant_id FROM workflow_runs r
          WHERE r.id = CASE WHEN j2.payload->>'runId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (j2.payload->>'runId')::uuid END),
        (SELECT n.tenant_id FROM negotiations n
          WHERE n.id = CASE WHEN j2.payload->>'negotiationId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (j2.payload->>'negotiationId')::uuid END),
        (SELECT a.tenant_id FROM agreements a
          WHERE a.id = CASE WHEN j2.payload->>'agreementId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (j2.payload->>'agreementId')::uuid END))
      LEFT JOIN tenant_directory d ON d.tenant_id = t.id
     WHERE j2.queue = 'agreements' AND j2.cell IS NULL AND j2.status IN ('pending', 'running')
  ) x
 WHERE j.id = x.id AND x.cell IS NOT NULL AND x.cell NOT IN ('', 'local', 'dev');
