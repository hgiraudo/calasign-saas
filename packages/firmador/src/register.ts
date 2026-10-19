// Registro del esquema calasign-firmador:// para que el link de la página de firma abra el Firmador.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEME = "calasign-firmador";

/** Contenido del .desktop de Linux (xdg). `exec` es la ruta del ejecutable. */
export function linuxDesktopEntry(exec: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Firmador CalaSign",
    "Comment=Firma documentos de CalaSign con tu certificado digital",
    `Exec="${desktopExecArg(exec)}" %u`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=x-scheme-handler/${SCHEME};`,
    "Categories=Office;Security;",
    "",
  ].join("\n");
}

/**
 * Argumento entre comillas de Exec (Desktop Entry Spec): dentro de las comillas van escapados " ` $ y \, después se
 * aplica el escape de los valores string (\ → \\) y % se duplica (si no, es un código de campo). Escapar solo las
 * comillas dejaba roto el registro con una ruta que tuviera $, \ o % (p. ej. ~/Descargas/100%/calasign-firmador).
 */
function desktopExecArg(path: string): string {
  return path.replace(/(["`$\\])/g, "\\$1").replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** Comandos `reg add` de Windows (HKCU, sin permisos de administrador). */
export function windowsRegistryCommands(exe: string): string[][] {
  const base = `HKCU\\Software\\Classes\\${SCHEME}`;
  return [
    ["add", base, "/ve", "/d", "URL:Firmador CalaSign", "/f"],
    ["add", base, "/v", "URL Protocol", "/d", "", "/f"],
    ["add", `${base}\\shell\\open\\command`, "/ve", "/d", `"${exe}" "%1"`, "/f"],
  ];
}

export function registerProtocol(exe = process.execPath): string {
  if (process.platform === "linux") {
    const dir = join(homedir(), ".local", "share", "applications");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "calasign-firmador.desktop");
    writeFileSync(file, linuxDesktopEntry(exe));
    try {
      execFileSync("xdg-mime", ["default", "calasign-firmador.desktop", `x-scheme-handler/${SCHEME}`]);
      execFileSync("update-desktop-database", [dir]);
    } catch {
      // xdg-utils puede no estar: el .desktop igual queda.
    }
    return `Registrado ${SCHEME}:// en ${file}`;
  }
  if (process.platform === "win32") {
    for (const args of windowsRegistryCommands(exe)) execFileSync("reg", args, { windowsHide: true });
    return `Registrado ${SCHEME}:// en HKCU\\Software\\Classes\\${SCHEME}`;
  }
  // macOS: el esquema se declara en el Info.plist del .app (CFBundleURLTypes); ver packages/firmador/README.md.
  return "En macOS el esquema se registra al instalar la app (Info.plist). Mientras tanto, pegá el código en el Firmador.";
}
