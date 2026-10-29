// Almacén de certificados de Windows (CurrentUser\My) vía PowerShell: incluye los certificados de tokens cuyo
// driver los publica en el almacén (eToken, ePass, DNIe…). La firma la hace Windows/el token: la clave no sale.
import { execFile } from "node:child_process";
import type { CertEntry, CertSource, ToSign } from "../types";

/** Argumentos de powershell.exe con el script en -EncodedCommand (UTF-16LE base64): sin problemas de comillas. */
export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/** Lista los certificados con clave privada, vigentes, con su cadena (X509Chain) en base64. */
export function windowsListScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$out = @()",
    "foreach ($c in Get-ChildItem Cert:\\CurrentUser\\My) {",
    "  if (-not $c.HasPrivateKey) { continue }",
    "  if ($c.NotAfter -lt (Get-Date)) { continue }",
    "  $ch = New-Object System.Security.Cryptography.X509Certificates.X509Chain",
    "  $ch.ChainPolicy.RevocationMode = 'NoCheck'",
    "  [void]$ch.Build($c)",
    "  $chain = @(); foreach ($e in $ch.ChainElements) { $chain += [Convert]::ToBase64String($e.Certificate.RawData) }",
    "  if ($chain.Count -eq 0) { $chain = @([Convert]::ToBase64String($c.RawData)) }",
    "  $out += [pscustomobject]@{ thumbprint = $c.Thumbprint; subject = $c.Subject; issuer = $c.Issuer; notAfter = $c.NotAfter.ToUniversalTime().ToString('o'); friendly = $c.FriendlyName; chain = $chain }",
    "}",
    "ConvertTo-Json -InputObject @($out) -Depth 4 -Compress",
  ].join("\n");
}

/** Firma un hash SHA-256 con la clave del certificado `thumbprint` (RSA PKCS#1 v1.5 o ECDSA r||s). */
export function windowsSignScript(thumbprint: string, digestBase64: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw new Error("thumbprint inválido");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(digestBase64)) throw new Error("hash SHA-256 inválido");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$c = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${thumbprint.toUpperCase()}'`,
    `$hash = [Convert]::FromBase64String('${digestBase64}')`,
    "$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)",
    "if ($rsa) {",
    "  $sig = $rsa.SignHash($hash, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "} else {",
    "  $ec = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($c)",
    "  if (-not $ec) { throw 'El certificado no tiene una clave RSA ni ECDSA utilizable' }",
    "  $sig = $ec.SignHash($hash)",
    "}",
    "[Convert]::ToBase64String($sig)",
  ].join("\n");
}

function runPowershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      powershellArgs(script),
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(
              String(stderr || err.message)
                .trim()
                .split("\n")[0],
            ),
          );
        else resolve(stdout.trim());
      },
    );
  });
}

export class WindowsStoreSource implements CertSource {
  readonly kind = "windows" as const;
  constructor(private readonly run: (script: string) => Promise<string> = runPowershell) {
    if (process.platform !== "win32" && run === runPowershell)
      throw new Error("El almacén de certificados de Windows solo está disponible en Windows");
  }
  async list(): Promise<CertEntry[]> {
    const raw = await this.run(windowsListScript());
    const items = (raw ? JSON.parse(raw) : []) as {
      thumbprint: string;
      subject: string;
      issuer: string;
      notAfter: string;
      friendly: string;
      chain: string[];
    }[];
    return items.map((i) => ({
      id: i.thumbprint,
      label: i.friendly || /CN=([^,]+)/.exec(i.subject)?.[1] || i.thumbprint,
      subject: i.subject,
      issuer: i.issuer,
      notAfter: i.notAfter,
      chainDer: i.chain.map((b) => new Uint8Array(Buffer.from(b, "base64"))),
    }));
  }
  async sign(entry: CertEntry, x: ToSign): Promise<Uint8Array> {
    const out = await this.run(windowsSignScript(entry.id, Buffer.from(x.digest).toString("base64")));
    return new Uint8Array(Buffer.from(out, "base64"));
  }
}
