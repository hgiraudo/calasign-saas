// tar.gz mínimo y determinista (ustar, fecha fija, orden dado). Lo usa el paquete npm del nodo de n8n
// (`npm install <url>.tgz`): npm espera los archivos bajo "package/".
import { gzipSync } from "node:zlib";

const MTIME = Math.floor(Date.UTC(2026, 0, 1) / 1000);

function octal(n, len) {
  return `${n.toString(8).padStart(len - 1, "0")}\0`;
}

function header(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: nombre demasiado largo (${name})`);
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(MTIME, 12), 136, 12, "ascii");
  h.fill(" ", 148, 156); // checksum: espacios mientras se calcula
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** entries: [{ name, data }] → Buffer .tgz */
export function makeTgz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data);
    parts.push(header(e.name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Lector (para las pruebas): Buffer .tgz → Map nombre → Buffer. */
export async function readTgz(buf) {
  const { gunzipSync } = await import("node:zlib");
  const raw = gunzipSync(buf);
  const out = new Map();
  let o = 0;
  while (o + 512 <= raw.length) {
    const name = raw
      .subarray(o, o + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      raw
        .subarray(o + 124, o + 136)
        .toString("ascii")
        .replace(/\0.*$/s, "")
        .trim(),
      8,
    );
    out.set(name, raw.subarray(o + 512, o + 512 + size));
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
