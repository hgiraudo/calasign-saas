// Algoritmo de firma según la clave del certificado (RSA o ECDSA P-256/P-384) y ECDSA sobre un digest ya calculado.
// node:crypto (y WebCrypto) siempre calculan el hash de los datos: para verificar (o, en el servidor CSC de prueba,
// producir) una firma ECDSA sobre el digest que firma un prestador remoto, la cuenta se hace acá con BigInt.
import { X509Certificate, createPrivateKey, randomBytes, type KeyObject } from "node:crypto";

export type CmsSignatureAlgorithm = "RSASSA-PKCS1-v1_5" | "ECDSA";

/** Tipo de clave del certificado del firmante (solo RSA y ECDSA P-256/P-384). */
export function signingAlgorithmFor(certDer: Uint8Array): { algorithm: CmsSignatureAlgorithm; namedCurve: string | null } {
  const key = new X509Certificate(Buffer.from(certDer)).publicKey;
  if (key.asymmetricKeyType === "rsa") return { algorithm: "RSASSA-PKCS1-v1_5", namedCurve: null };
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve ?? null;
    if (curve !== "prime256v1" && curve !== "secp384r1") throw new Error(`curva no soportada: ${curve ?? "desconocida"}`);
    return { algorithm: "ECDSA", namedCurve: curve };
  }
  throw new Error(`tipo de clave no soportado: ${key.asymmetricKeyType}`);
}

/** ECDSA: acepta DER o r||s (IEEE P1363, lo que devuelven PKCS#11 y Windows) y devuelve DER. */
export function normalizeEcdsaSignature(sig: Uint8Array, namedCurve: string | null): Uint8Array {
  const coord = namedCurve === "secp384r1" ? 48 : 32;
  // r||s cuyo primer byte es 0x30 (1 de cada 256) no es DER: se mira la estructura completa, no solo el tag.
  if (sig.length === coord * 2 && !isDerEcdsa(sig)) return ecdsaDer(bytesToBig(sig.subarray(0, coord)), bytesToBig(sig.subarray(coord)));
  return sig;
}

/** SEQUENCE { INTEGER r, INTEGER s } en DER que ocupa exactamente `sig` (longitudes cortas: hasta P-384). */
function isDerEcdsa(sig: Uint8Array): boolean {
  if (sig.length < 8 || sig[0] !== 0x30 || sig[1] !== sig.length - 2 || sig[2] !== 0x02) return false;
  const rLen = sig[3];
  const sTag = 4 + rLen;
  return sTag + 2 <= sig.length && sig[sTag] === 0x02 && sig[sTag + 1] === sig.length - sTag - 2;
}

// ───────────── Curvas (FIPS 186-4 / SEC 2) ─────────────

interface Curve {
  p: bigint;
  a: bigint;
  n: bigint;
  gx: bigint;
  gy: bigint;
  bytes: number;
}

const CURVES: Record<string, Curve> = {
  prime256v1: {
    p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
    a: 0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn,
    n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
    gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
    bytes: 32,
  },
  secp384r1: {
    p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
    a: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffcn,
    n: 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
    gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
    bytes: 48,
  },
};

const mod = (x: bigint, m: bigint) => ((x % m) + m) % m;

function inv(x: bigint, m: bigint): bigint {
  let [a, b, u, v] = [mod(x, m), m, 1n, 0n];
  while (a !== 0n) {
    const q = b / a;
    [a, b] = [b - q * a, a];
    [u, v] = [v - q * u, u];
  }
  if (b !== 1n) throw new Error("sin inverso");
  return mod(v, m);
}

/** Punto en coordenadas jacobianas (Z = 0: infinito). */
type J = [bigint, bigint, bigint];
const INF: J = [0n, 1n, 0n];

function dbl(c: Curve, [x, y, z]: J): J {
  if (z === 0n || y === 0n) return INF;
  const { p, a } = c;
  const y2 = mod(y * y, p);
  const s = mod(4n * x * y2, p);
  const z2 = mod(z * z, p);
  const m = mod(3n * x * x + a * z2 * z2, p);
  const x3 = mod(m * m - 2n * s, p);
  const y3 = mod(m * (s - x3) - 8n * y2 * y2, p);
  return [x3, y3, mod(2n * y * z, p)];
}

function add(c: Curve, P: J, Q: J): J {
  if (P[2] === 0n) return Q;
  if (Q[2] === 0n) return P;
  const { p } = c;
  const z1s = mod(P[2] * P[2], p);
  const z2s = mod(Q[2] * Q[2], p);
  const u1 = mod(P[0] * z2s, p);
  const u2 = mod(Q[0] * z1s, p);
  const s1 = mod(P[1] * z2s * Q[2], p);
  const s2 = mod(Q[1] * z1s * P[2], p);
  if (u1 === u2) return s1 === s2 ? dbl(c, P) : INF;
  const h = mod(u2 - u1, p);
  const r = mod(s2 - s1, p);
  const h2 = mod(h * h, p);
  const h3 = mod(h2 * h, p);
  const x3 = mod(r * r - h3 - 2n * u1 * h2, p);
  const y3 = mod(r * (u1 * h2 - x3) - s1 * h3, p);
  return [x3, y3, mod(h * P[2] * Q[2], p)];
}

function mul(c: Curve, k: bigint, P: J): J {
  let R = INF;
  let A = P;
  while (k > 0n) {
    if (k & 1n) R = add(c, R, A);
    A = dbl(c, A);
    k >>= 1n;
  }
  return R;
}

function affineX(c: Curve, P: J): bigint | null {
  if (P[2] === 0n) return null;
  const zi = inv(P[2], c.p);
  return mod(P[0] * zi * zi, c.p);
}

const bytesToBig = (b: Uint8Array) => (b.length ? BigInt(`0x${Buffer.from(b).toString("hex")}`) : 0n);
const b64uToBig = (s: string) => bytesToBig(Buffer.from(s, "base64url"));

/** Entero del digest (los bits de la izquierda, hasta el tamaño del orden de la curva). */
function digestInt(c: Curve, digest: Uint8Array): bigint {
  let e = bytesToBig(digest);
  const extra = digest.length * 8 - c.n.toString(2).length;
  if (extra > 0) e >>= BigInt(extra);
  return e;
}

function intDer(v: bigint): number[] {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = [...Buffer.from(hex, "hex")];
  if (b[0] & 0x80) b = [0, ...b];
  return [0x02, b.length, ...b];
}

function ecdsaDer(r: bigint, s: bigint): Uint8Array {
  const body = [...intDer(r), ...intDer(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

function parseDer(sig: Uint8Array): { r: bigint; s: bigint } | null {
  if (!isDerEcdsa(sig)) return null;
  const rLen = sig[3];
  return { r: bytesToBig(sig.subarray(4, 4 + rLen)), s: bytesToBig(sig.subarray(6 + rLen)) };
}

function curveOf(key: KeyObject): Curve {
  const c = CURVES[key.asymmetricKeyDetails?.namedCurve ?? ""];
  if (key.asymmetricKeyType !== "ec" || !c) throw new Error("se esperaba una clave ECDSA P-256 o P-384");
  return c;
}

/** Verifica una firma ECDSA (DER o r||s) sobre un digest ya calculado, con la clave pública del certificado. */
export function verifyEcdsaDigest(certDer: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = new X509Certificate(Buffer.from(certDer)).publicKey;
    const c = curveOf(key);
    const jwk = key.export({ format: "jwk" });
    const Q: J = [b64uToBig(jwk.x!), b64uToBig(jwk.y!), 1n];
    const rs = parseDer(normalizeEcdsaSignature(signature, key.asymmetricKeyDetails!.namedCurve!));
    if (!rs) return false;
    const { r, s } = rs;
    if (r <= 0n || r >= c.n || s <= 0n || s >= c.n) return false;
    const w = inv(s, c.n);
    const u1 = mod(digestInt(c, digest) * w, c.n);
    const u2 = mod(r * w, c.n);
    const X = add(c, mul(c, u1, [c.gx, c.gy, 1n]), mul(c, u2, Q));
    const x = affineX(c, X);
    return x !== null && mod(x, c.n) === r;
  } catch {
    return false;
  }
}

/**
 * Firma ECDSA (DER) de un digest ya calculado. Solo para el servidor CSC de prueba (csc-mock.ts): k aleatorio, sin
 * protección contra canales laterales.
 */
export function ecdsaSignDigestForTests(privateKeyPem: string, digest: Uint8Array): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  const c = curveOf(key);
  const d = b64uToBig(key.export({ format: "jwk" }).d!);
  const e = digestInt(c, digest);
  for (;;) {
    const k = mod(bytesToBig(randomBytes(c.bytes + 8)), c.n - 1n) + 1n;
    const x = affineX(c, mul(c, k, [c.gx, c.gy, 1n]));
    if (x === null) continue;
    const r = mod(x, c.n);
    if (r === 0n) continue;
    const s = mod(inv(k, c.n) * (e + r * d), c.n);
    if (s === 0n) continue;
    return ecdsaDer(r, s);
  }
}
