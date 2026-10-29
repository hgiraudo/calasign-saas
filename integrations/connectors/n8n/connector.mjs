// Nodos de n8n (paquete comunitario n8n-nodes-calasign). El build compila el TypeScript con esbuild (CommonJS,
// n8n-workflow externo, quicksend empaquetado: cero dependencias en runtime, como pide la verificación de n8n) y publica:
//   n8n-nodes-calasign-<versión>.tgz   paquete npm instalable (`npm install <url>` en ~/.n8n/nodes)
//   n8n-nodes-calasign-source.zip      fuentes para publicar en npm/GitHub con @n8n/node-cli
import { join } from "node:path";
import { makeTgz } from "../../lib/tar.mjs";

export const meta = {
  id: "n8n",
  name: "n8n",
  description:
    "Paquete de nodos comunitarios: CalaSign (enviar desde plantilla, enviar PDF, estado, PDF firmado, anular, recordar) y CalaSign Trigger (webhook con firma HMAC).",
};

const ENTRIES = [
  "credentials/CalaSignApi.credentials.ts",
  "credentials/CalaSignOAuth2Api.credentials.ts",
  "nodes/CalaSign/CalaSign.node.ts",
  "nodes/CalaSignTrigger/CalaSignTrigger.node.ts",
];
const SOURCES = ["package.json", "README.md", "tsconfig.json", "nodes/GenericFunctions.ts", "nodes/quicksend.d.ts", "nodes/calasign.svg", ...ENTRIES];

export async function build(ctx) {
  const pkg = ctx.load("package.json");
  const version = JSON.parse(pkg.toString("utf8")).version;
  const quicksendPath = join(ctx.dir, "../_lib/quicksend.cjs");
  const plugin = {
    name: "calasign-paths",
    setup(b) {
      b.onResolve({ filter: /\/quicksend$/ }, () => ({ path: quicksendPath }));
      // Variables {{BASE_URL}}/{{VERSION}} en el TypeScript.
      b.onLoad({ filter: /\.ts$/ }, (args) => ({ contents: ctx.load(args.path.slice(ctx.dir.length + 1)).toString("utf8"), loader: "ts" }));
    },
  };
  const dist = [];
  for (const entry of ENTRIES) {
    const code = await ctx.bundle(join(ctx.dir, entry), {
      platform: "node",
      format: "cjs",
      target: "node20",
      minify: false,
      external: ["n8n-workflow"],
      plugins: [plugin],
    });
    dist.push({ name: `dist/${entry.replace(/\.ts$/, ".js")}`, data: code });
  }
  for (const d of ["nodes/CalaSign", "nodes/CalaSignTrigger", "credentials"])
    dist.push({ name: `dist/${d}/calasign.svg`, data: ctx.load("nodes/calasign.svg") });
  const npmFiles = [{ name: "package.json", data: pkg }, { name: "README.md", data: ctx.load("README.md") }, ...dist];
  const sources = SOURCES.map((f) => ({ name: f, data: ctx.load(f) }));
  sources.push({ name: "nodes/quicksend.js", data: ctx.shared("quicksend.cjs") });
  return {
    files: [{ name: "README.md", data: ctx.load("README.md") }],
    artifacts: [
      {
        name: `n8n-nodes-calasign-${version}.tgz`,
        data: makeTgz(npmFiles.map((f) => ({ name: `package/${f.name}`, data: f.data }))),
        description: "n8n: paquete npm de nodos comunitarios (.tgz)",
      },
      { name: "n8n-nodes-calasign-source.zip", entries: sources, description: "n8n: fuentes del paquete (zip)" },
    ],
  };
}
