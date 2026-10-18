// Página del proveedor simulado (pagos y suscripciones de prueba). Sin scripts: un formulario POST.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * CSP propia de la página simulada: sin scripts, estilos en línea y el formulario solo hacia este origen y el de
 * regreso (que puede ser el dominio propio de la organización). Sin upgrade-insecure-requests, para que funcione en local.
 */
export function mockPageCsp(returnOrigin?: string | null) {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${returnOrigin ? ` ${returnOrigin}` : ""}; frame-ancestors 'none'; base-uri 'none'`;
}

export function mockPage(p: { title: string; lead: string; amount: string; description: string; action: string; paid: boolean; payLabel?: string }) {
  const btn = (outcome: string, label: string, primary: boolean) =>
    `<button name="outcome" value="${outcome}" style="font:inherit;font-weight:600;padding:12px 20px;border-radius:8px;cursor:pointer;${
      primary ? "background:#0f766e;color:#fff;border:0" : "background:#fff;color:#0b1f3a;border:1px solid #c9d1dc"
    }">${label}</button>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)} · CalaSign</title></head>
<body style="margin:0;background:#f3f5f8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0b1f3a">
<main style="max-width:440px;margin:48px auto;padding:0 16px">
<div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(11,31,58,.12);overflow:hidden">
<div style="background:#0b1f3a;color:#fff;padding:16px 24px;font-weight:700">Cala<span style="color:#2ec4b6">Sign</span> · ${escapeHtml(p.title)}</div>
<div style="padding:24px">
<p style="margin:0 0 4px;color:#5b6576;font-size:14px">${p.lead}</p>
<p style="margin:0 0 16px;font-size:15px">${escapeHtml(p.description)}</p>
<p style="margin:0 0 20px;font-size:28px;font-weight:700">${escapeHtml(p.amount)}</p>
<div role="note" style="background:#fff7e6;border:1px solid #f5d39a;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:20px">
Proveedor de prueba: no se mueve dinero. Solo existe fuera de producción.</div>
${
  p.paid
    ? `<p style="font-weight:600;color:#0f766e">Este pago ya está confirmado.</p>`
    : `<form method="post" action="${escapeHtml(p.action)}" style="display:flex;gap:12px;flex-wrap:wrap">${btn("paid", p.payLabel ?? "Pagar", true)}${btn("failed", "Rechazar", false)}</form>`
}
</div></div></main></body></html>`;
}
