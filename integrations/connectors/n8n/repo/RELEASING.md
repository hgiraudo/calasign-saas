# Publicar n8n-nodes-calasign en npm

Este repo se genera desde el monorepo de CalaSign (`integrations/connectors/n8n/`) con
`node integrations/connectors/n8n/export-repo.mjs`. Los cambios de código se hacen allá y se vuelven a exportar; acá
solo se versiona y se publica.

n8n exige, desde el 1 de mayo de 2026, que los nodos comunitarios se publiquen **desde GitHub Actions con provenance**
de npm. El workflow `.github/workflows/publish.yml` lo hace al pushear un tag `x.y.z`.

## Una sola vez

1. **Repo en GitHub (público):**
   ```bash
   gh repo create {{REPO}} --public --source . --remote origin --push
   ```
2. **Primera publicación en npm.** npm solo deja configurar Trusted Publishing en un paquete que ya existe, así que la
   primera versión sale con un token:
   - npmjs.com → Access Tokens → Generate New Token → *Granular Access Token*, permiso *Read and write* para
     paquetes (si el nombre todavía no existe, sin restringir a un paquete).
   - GitHub → {{REPO}} → Settings → Secrets and variables → Actions → New secret `NPM_TOKEN`.
3. **Pasar a Trusted Publishing (sin secretos)** después de la primera versión:
   - npmjs.com → paquete `n8n-nodes-calasign` → Settings → Trusted Publisher → GitHub Actions:
     owner `{{REPO_OWNER}}`, repo `{{REPO_NAME}}`, workflow `publish.yml`.
   - Borrar el secret `NPM_TOKEN` del repo.

## Cada versión

```bash
pnpm install
pnpm run lint && pnpm run build
pnpm run release      # elige la versión, actualiza CHANGELOG, commitea, tagea y pushea → publica el workflow
```

Verificá la publicación en https://www.npmjs.com/package/n8n-nodes-calasign (sección *Provenance*).

## Verificación de n8n (para que aparezca en el buscador de nodos de n8n Cloud)

1. Pasar el escáner: `npx @n8n/scan-community-package n8n-nodes-calasign` (sobre la versión publicada).
2. Enviar el paquete en el n8n Creator Portal (https://creators.n8n.io) con el link a npm, el repo y la documentación
   ({{BASE_URL}}/developers/connectors#n8n).
3. Requisitos que ya cumple este paquete: nombre `n8n-nodes-*`, keyword `n8n-community-node-package`, sin
   dependencias de runtime, lint de `@n8n/node-cli` limpio, MIT, README en inglés.
