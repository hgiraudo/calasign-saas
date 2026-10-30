# Estándares de código — frontend (`apps/web`)

> React 18 + Vite + TypeScript estricto, sin framework de componentes ni Tailwind: componentes propios
> (`components/ui.tsx`) y CSS con variables por área (`styles*.css`). Una sola SPA con tres públicos que no se
> parecen: el **remitente** (consola `/app`), el **firmante** (`/s/:token`, sin cuenta, a menudo en un celular) y las
> **páginas públicas** (`/verify`, `/developers`, formularios web). La sirve la API desde `apps/web/dist`.

---

## 1. El contrato y la red

### 1.1 Los tipos vienen de `@calasign/shared`, y `tsc` es el gate

La web y la API comparten los esquemas Zod y los tipos de `packages/shared` (ver
[decisiones §2](decisiones-de-diseno.md#2-el-contrato-vive-en-packagesshared-zod-sin-codegen-)). No hay tipos espejados
a mano: un campo nuevo en la respuesta se agrega en `shared` y lo ven los dos lados en el mismo commit.

```bash
(cd apps/web && ./node_modules/.bin/tsc --noEmit)   # 0 errores, siempre (lo corre qa.sh y el build)
```

🔴 Un `as Algo` o un `any` para saltar el contrato es exactamente el bug que `tsc` existe para cazar.

### 1.2 Prohibido → usar en su lugar

| Prohibido | Usar en su lugar | Por qué |
|---|---|---|
| `fetch("/v1/…")` suelto en un componente | `api<T>()` de `lib/api.ts` (o `fetchResponse` / `fetchArrayBuffer` para binarios) | Centraliza cookie, timeout, reintento de lecturas, 401 → login, 403 → recargar permisos, 409 `tenant_mismatch` |
| Un host o puerto hardcodeado (`http://localhost:4000`) | Rutas relativas: la API y la web son el **mismo origen** | En dev y con dominio propio el host cambia; un host fijo deja la UI muerta |
| Mostrar `e.message` de un error | `errorText(e)` | Traduce el `code` de la API a ES/PT-BR/EN; el mensaje crudo está siempre en español |
| Un texto visible escrito en el JSX | Una clave del diccionario del área (`useTeamsText()`, `useI18n().t`…) | La web es trilingüe; un literal sale en castellano para un brasileño |
| `any` | El tipo de `@calasign/shared`, o `unknown` + narrowing | El contrato compartido es lo único que valida el acople |
| `useEffect` que hace `setState` después de un `await` sin guarda | Guarda de vigencia (`let vivo = true` / contador de generación, ver `AuditLog.tsx`) | Una respuesta vieja pisa a la nueva al cambiar filtros, o setea un componente desmontado |
| `JSON.parse(localStorage.getItem(…)!)` | `try/catch` con un default | En ventana privada o con almacenamiento lleno lanza, y la pantalla queda en blanco |
| Colores hex sueltos en un `.tsx` | Las variables CSS (`var(--teal-dark)`, `var(--danger)`…) | La marca blanca reemplaza los colores: un hex suelto no cambia y rompe el contraste |
| `npm` / `yarn` | `corepack pnpm` | El lockfile es de pnpm; mezclarlos deja dos árboles |

### 1.3 Concurrencia optimista al guardar

Todo lo que se edita desde dos pestañas o por dos personas manda `X-Expected-Updated-At` con el `updatedAt` que cargó
(`runVersioned` en `lib/api.ts`), y ante el 409 `version_changed` la UI **lo dice** y ofrece recargar
(`isVersionChanged`). Una entidad editable nueva lleva el mismo tratamiento: se pisaba a ciegas antes.

---

## 2. Componentes

### 2.1 Los tres estados son obligatorios y distintos

```tsx
// ✅ El patrón de la casa (ver pages/AuditLog.tsx)
const [items, setItems] = useState<AuditLogEntry[] | null>(null);   // null = cargando
const [error, setError] = useState<string | null>(null);

if (error) return <ErrorBox error={error} />;
if (!items) return <Spinner />;
if (items.length === 0) return <p className="hint">{tt("audit.empty")}</p>;   // qué falta y cómo conseguirlo
return <table>…</table>;
```

Un `useState<Fila[]>([])` inicial confunde «cargando» con «no hay nada», y un error que no se muestra se lee como
«no hay nada» también. **Un vacío que puede tener dos causas dice cuál**: «no hay sobres» no es lo mismo que «tu
filtro no incluye ninguno».

### 2.2 Nada bloquea sin decir por qué

Un botón deshabilitado lleva el motivo (texto al lado o `title`), y una acción que el plan o el rol no permite dice
cuál de los dos es. La consola ya escucha el 403 para recargar permisos: no ofrecer lo que el usuario no puede hacer.

### 2.3 Tamaño

Las páginas grandes están asumidas (`Signer.tsx` 1.203 líneas, `Documents.tsx` 1.125, `EnvelopeEdit.tsx` 1.112): son
orquestadores con estado interdependiente. **No se parten por el número.** Lo que sí corresponde al crecer:

- Un componente propio para una sección con **su** estado que no comparte nada (como `components/FieldEditor.tsx`).
- Lógica pura a `lib/` (testeable sin DOM: `lib/logic.ts`, `lib/csv.ts`).
- Textos a un diccionario de área (`lib/i18n-<área>.ts`), no a `lib/i18n.tsx`, que es el núcleo compartido.

Umbral para código **nuevo**: una página de más de ~600 líneas que no sea un orquestador se justifica.

---

## 3. Idiomas, fechas y formatos

- **Tres idiomas, siempre los tres**: `es`, `pt-BR`, `en`. Cada diccionario de área declara `pt` y `en` como
  `Record<Key, string>` sobre las claves de `es`: **`tsc` falla si falta una traducción**. No se aflojan con `Partial`.
- **Marca blanca**: los textos que una organización puede reemplazar pasan por `brandText` (`lib/white-label.ts`). No
  se lee el diccionario directo en esas pantallas.
- **Fechas en el idioma y la zona del navegador** con `formatDateTime` / `formatDate` de `lib/i18n.tsx`; la API manda
  ISO 8601 en UTC. Nunca `toLocaleString()` suelto ni concatenar partes de una fecha.
- **Números y monedas** con `Intl.NumberFormat` del idioma activo (USD, BRL, COP, DOP, HNL y PEN).
- **Códigos de error nuevos de la API** → texto en `CODE_TEXT` (`lib/api.ts`) o `MORE_CODE_TEXT`
  (`lib/api-error-text.ts`). `scripts/check-error-codes.mjs` lo verifica en `qa.sh`.

---

## 4. El firmante: celular, red mala y nada de cuenta

Es la pantalla que más importa y la que peor se prueba en un escritorio. Lo que ya está y no se rompe:

- **Funciona en navegadores viejos**: pdf.js tiene la variante legacy (Safari < 17.4, iOS 16). Una API de JS nueva se
  usa con detección y alternativa.
- **Red mala**: tiempos de espera, un reintento de lecturas y un botón Reintentar. Nada queda girando para siempre.
- **Memoria**: los lienzos tienen presupuesto (60 MP táctil / 150 MP). Un PDF de 200 páginas no tumba un celular.
- **Después de un deploy**, una pestaña abierta se recarga sola si el chunk que pide ya no existe (`lib/deploy-reload.ts`).
- **La descarga del PDF firmado y de la copia en curso** está siempre a la vista al terminar.

---

## 5. Estilos, marca y accesibilidad

- **Colores por variable CSS** (`:root` en `styles.css`), nunca hex en el JSX. La marca blanca reemplaza `--navy`,
  `--teal` y compañía; el contraste lo garantiza `packages/shared` (`contrastText`, `darkenToContrast`) y lo prueba
  `apps/api/test/contrast.test.ts`.
- **Contraste ≥ 4.5:1** en texto (WCAG AA). Un color nuevo con su medición en el comentario, como `--teal-dark`.
- **Teclado**: todo lo clickeable es un `<button>` o un `<a>`, con foco visible. Al cambiar de ruta el foco va al
  contenido; hay «saltar al contenido». Un modal atrapa el foco y lo devuelve al cerrar.
- **Etiquetas**: todo `<input>` tiene `<label>` (o `aria-label`); cada página tiene título (`useTitle`).
- **Rutas cargadas bajo demanda** (`lazy`) y pdf.js en un chunk aparte: la entrada pasó de 1,68 MB a 564 kB. Una
  dependencia pesada nueva va en su propio chunk.

---

## 6. Checklist pre-commit (frontend)

- [ ] `tsc --noEmit` en `apps/web` → 0 errores, Prettier y ESLint sin errores (`./scripts/qa.sh --rapido`)
- [ ] `./scripts/qa.sh --web` verde (Playwright); pantalla nueva en un camino crítico → su test en `apps/web/e2e/`
- [ ] Ningún aviso nuevo de `react-hooks/exhaustive-deps` (el total no sube de 4)
- [ ] Tipos de la API desde `@calasign/shared`; campo nuevo agregado ahí, en **este** commit
- [ ] Todo pedido por `api()` / `fetchResponse`; ningún host hardcodeado; errores con `errorText`
- [ ] Ningún texto visible literal: clave en el diccionario del área, en ES, PT-BR y EN
- [ ] Cargando / error / vacío distinguibles, con un mensaje que dice qué falta
- [ ] Respuestas viejas no pisan a las nuevas (guarda de vigencia en los `useEffect` con `await`)
- [ ] Entidad editable nueva → `X-Expected-Updated-At` y manejo del 409
- [ ] Colores desde variables CSS; contraste medido si hay un color nuevo
- [ ] Teclado y lector de pantalla: botones de verdad, `label`, foco visible
- [ ] Pantalla del firmante tocada → probada en un ancho de celular y con la red lenta (DevTools)
