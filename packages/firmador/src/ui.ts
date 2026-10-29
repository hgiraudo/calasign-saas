// Interfaz local del Firmador: un servidor en 127.0.0.1 (puerto al azar, ruta con token secreto) que se abre en el
// navegador. Ninguna clave ni PIN sale de la computadora: el navegador habla solo con este proceso, y este proceso
// solo envía a CalaSign el certificado (público) y la firma del hash.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CertsignClient, CertsignError, apiHost, apiHostTrusted, parseDeepLink, signWithEntry } from "./protocol";
import { P12Source } from "./sources/p12";
import { Pkcs11Source, detectPkcs11Modules } from "./sources/pkcs11";
import { WindowsStoreSource } from "./sources/windows";
import type { CertSource } from "./types";

export const VERSION = "0.1.0";

interface SourceSpec {
  kind: "windows" | "pkcs11" | "p12";
  module?: string;
  pin?: string;
  slot?: number;
  p12?: string; // base64
  password?: string;
}

function openSource(s: SourceSpec): CertSource {
  if (s.kind === "windows") return new WindowsStoreSource();
  if (s.kind === "pkcs11") {
    if (!s.module) throw new Error("Elegí el módulo PKCS#11 de tu token");
    return new Pkcs11Source(s.module, s.pin ?? "", s.slot ?? 0);
  }
  if (!s.p12) throw new Error("Elegí el archivo .p12/.pfx");
  return P12Source.fromBytes(new Uint8Array(Buffer.from(s.p12, "base64")), s.password ?? "");
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 25 * 1024 * 1024) throw new Error("demasiado grande");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function startUi(initial: { api?: string | null; code?: string | null } = {}, open = true) {
  const token = randomBytes(24).toString("base64url");
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    // Defensa contra DNS rebinding y otras páginas del navegador.
    const port = (server.address() as { port: number }).port;
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: "host" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith(`/${token}`)) return send(404, { error: "not_found" });
    const path = url.pathname.slice(token.length + 1) || "/";
    try {
      if (req.method === "GET" && path === "/") return send(200, page(initial), "text/html; charset=utf-8");
      if (req.method !== "POST" || req.headers["content-type"] !== "application/json") return send(405, { error: "method" });
      const body = await readJson(req);
      if (path === "/modules") return send(200, { platform: process.platform, modules: detectPkcs11Modules() });
      const link = parseDeepLink(String(body.code ?? "")) ?? { api: null, code: String(body.code ?? "") };
      const api = String(body.api || link.api || "");
      const client = new CertsignClient(api, link.code);
      const host = apiHost(api);
      const trustedHost = apiHostTrusted(api);
      if (path === "/info") return send(200, { ...(await client.info()), apiHost: host, trustedHost });
      const source = openSource(body.source as SourceSpec);
      try {
        const certs = await source.list();
        if (path === "/list") return send(200, { certs: certs.map(({ chainDer, ...c }) => ({ ...c, chainLength: chainDer.length })) });
        if (path === "/sign") {
          // Un servidor que no es de CalaSign solo se acepta con la confirmación explícita del usuario.
          if (!trustedHost && body.confirmHost !== host) {
            return send(409, {
              error: {
                code: "confirm_host",
                message: `${host} no es un servidor de CalaSign conocido. ¿Confiás en él para firmar este documento?`,
                details: { host },
              },
            });
          }
          const entry = certs.find((c) => c.id === body.certId);
          if (!entry) return send(400, { error: { message: "Elegí un certificado" } });
          const out = await signWithEntry(client, source, entry);
          return send(200, out);
        }
      } finally {
        await source.close?.();
      }
      return send(404, { error: "not_found" });
    } catch (e) {
      const err = e as CertsignError;
      return send(err.status && err.status >= 400 ? err.status : 400, {
        error: { code: err.code ?? "error", message: err.message, details: err.details },
      });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${token}`;
  if (open) openBrowser(url);
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd[0] as string, cmd[1] as string[], () => {});
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(initial: { api?: string | null; code?: string | null }): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firmador CalaSign</title>
<style>
:root{--ink:#0b1f3a;--muted:#5b6576;--accent:#0f766e;--line:#d8dee8;--bg:#f3f5f8;--err:#b42318}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--ink);color:#fff;padding:14px 20px;font-weight:700}header span{color:#2ec4b6}
main{max-width:720px;margin:24px auto;padding:0 16px}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:0 0 12px}.muted{color:var(--muted)}label{display:block;font-weight:600;margin:12px 0 4px}
input,select{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;margin-top:14px}
button:disabled{opacity:.5;cursor:default}.tabs{display:flex;gap:8px;flex-wrap:wrap}.tabs button{background:#e6eaf0;color:var(--ink);margin:0}.tabs button.on{background:var(--ink);color:#fff}
.cert{border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;cursor:pointer}.cert.on{border-color:var(--accent);box-shadow:0 0 0 2px #0f766e33}
.err{color:var(--err);font-weight:600}.ok{color:var(--accent);font-weight:700}.small{font-size:13px}code{background:#eef1f5;padding:2px 6px;border-radius:4px}
</style></head><body><header>Cala<span>Sign</span> · Firmador ${VERSION}</header><main>
<div class="card"><h1>Firmar con tu certificado digital</h1><p class="muted">Tu clave privada no sale de esta computadora ni de tu token: CalaSign solo recibe tu certificado y la firma.</p>
<label for="code">Código de firma</label><input id="code" value="${esc(initial.code ?? "")}" placeholder="ABCDE-FGHIJ" autocomplete="off">
<label for="api">Dirección de CalaSign</label><input id="api" value="${esc(initial.api ?? "")}" placeholder="https://app.calasign.com">
<button id="load">Continuar</button><p id="infoErr" class="err" role="alert"></p></div>
<div class="card" id="doc" hidden><h2>Documento</h2><div id="docInfo"></div></div>
<div class="card" id="pick" hidden><h2>¿Dónde está tu certificado?</h2>
<div class="tabs" role="tablist"><button data-k="windows">Certificados de Windows</button><button data-k="pkcs11">Token USB</button><button data-k="p12">Archivo .p12 / .pfx</button></div>
<div id="src-windows" hidden><p class="muted small">Incluye los certificados de tokens cuyo driver los publica en Windows.</p></div>
<div id="src-pkcs11" hidden><label for="mod">Módulo del token</label><select id="mod"></select><input id="modPath" placeholder="o la ruta al módulo PKCS#11 (.dll / .so / .dylib)">
<label for="pin">PIN del token</label><input id="pin" type="password" autocomplete="off"></div>
<div id="src-p12" hidden><label for="file">Archivo</label><input id="file" type="file" accept=".p12,.pfx"><label for="pw">Contraseña</label><input id="pw" type="password" autocomplete="off"></div>
<button id="list" disabled>Ver certificados</button><div id="certs"></div><button id="sign" hidden>Firmar</button><p id="err" class="err" role="alert"></p></div>
<div class="card" id="done" hidden><p class="ok">Listo: firmaste el documento con tu certificado.</p><p class="muted small" id="doneInfo"></p><p>Podés cerrar esta ventana y volver a CalaSign.</p></div>
<script>
const $=id=>document.getElementById(id);let kind=null,cert=null,p12=null;
const post=async(p,b)=>{const r=await fetch(location.pathname+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok){const e=new Error(j.error&&j.error.message||'Error');e.code=j.error&&j.error.code;e.details=j.error&&j.error.details;throw e}return j};
const base=()=>({code:$('code').value.trim(),api:$('api').value.trim()});
const src=()=>kind==='pkcs11'?{kind,module:$('modPath').value.trim()||$('mod').value,pin:$('pin').value}:kind==='p12'?{kind,p12,password:$('pw').value}:{kind:'windows'};
$('load').onclick=async()=>{$('infoErr').textContent='';try{const i=await post('/info',base());$('doc').hidden=false;$('pick').hidden=false;
$('docInfo').innerHTML='<b></b><div class=muted></div><div class="small muted"></div><div class="small"></div>';const d=$('docInfo').children;d[3].textContent='Servidor: '+i.apiHost+(i.trustedHost?'':' (no es un servidor de CalaSign conocido)');if(!i.trustedHost)d[3].className='err small';d[0].textContent=i.envelopeSubject;d[1].textContent=i.organizationName+' · firma '+i.signerName+(i.idDocument?' ('+i.idDocument+')':'');d[2].textContent='SHA-256 '+i.documentSha256+(i.requirements.allowedIssuers.length?' · emisores permitidos: '+i.requirements.allowedIssuers.join(', '):'');}catch(e){$('infoErr').textContent=e.message}};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=async()=>{kind=b.dataset.k;document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));['windows','pkcs11','p12'].forEach(k=>$('src-'+k).hidden=k!==kind);$('list').disabled=false;
if(kind==='pkcs11'&&!$('mod').options.length){const m=await post('/modules',{});$('mod').innerHTML=m.modules.map(x=>'<option value="'+x.path.replace(/"/g,'&quot;')+'">'+x.vendor+'</option>').join('')||'<option value="">(no se detectó ningún token: indicá la ruta)</option>'}});
$('file').onchange=async()=>{const f=$('file').files[0];if(!f)return;const b=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));p12=btoa(s)};
$('list').onclick=async()=>{$('err').textContent='';$('certs').innerHTML='';$('sign').hidden=true;cert=null;try{const r=await post('/list',{...base(),source:src()});
if(!r.certs.length){$('err').textContent='No hay certificados con clave privada disponibles.';return}
r.certs.forEach(c=>{const el=document.createElement('div');el.className='cert';el.tabIndex=0;el.innerHTML='<b></b><div class="small muted"></div>';el.children[0].textContent=c.label;el.children[1].textContent=c.subject+' · emitido por '+c.issuer+' · vence '+c.notAfter.slice(0,10);
el.onclick=el.onkeydown=()=>{cert=c.id;document.querySelectorAll('.cert').forEach(x=>x.classList.toggle('on',x===el));$('sign').hidden=false};$('certs').appendChild(el)})}catch(e){$('err').textContent=e.message}};
$('sign').onclick=async()=>{$('err').textContent='';$('sign').disabled=true;try{const body={...base(),source:src(),certId:cert};let r;try{r=await post('/sign',body)}catch(e){if(e.code!=='confirm_host'||!confirm(e.message))throw e;r=await post('/sign',{...body,confirmHost:e.details.host})}$('pick').hidden=true;$('done').hidden=false;
$('doneInfo').textContent=r.prepared.certificate.commonName+' · '+r.prepared.certificate.issuer+(r.prepared.warnings.length?' · '+r.prepared.warnings.join('; '):'')}catch(e){$('err').textContent=e.message;$('sign').disabled=false}};
if($('code').value&&$('api').value)$('load').click();
</script></main></body></html>`;
}
