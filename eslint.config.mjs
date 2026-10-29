// ESLint del monorepo (docs/estandares/decisiones-de-diseno.md §8). Sin reglas que necesiten información de tipos:
// tsc ya es el gate de tipos y una configuración con type-checking tardaría minutos por paquete.
//
// Lo que ya mide el trinquete (scripts/check-calidad.mjs) no se repite acá: `any` y `catch` vacíos están apagados.
// Errores: cero (scripts/qa.sh y el hook de pre-commit). Las reglas en "warn" (react-hooks/exhaustive-deps) no
// frenan, pero el total no puede subir: qa.sh corre con --max-warnings igual a lo medido (ESLINT_MAX_WARNINGS).
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "var/**",
      ".claude/**",
      "apps/web/public/integrations/**",
      "packages/firmador/build/out/**",
      "sdks/python/**",
      "infra/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      // Las mide el trinquete por archivo.
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `_` al principio: no usado a propósito (firma de un callback, desestructuración para descartar).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // El repo usa `declare module` para extender Fastify y namespaces de tipos en algunos paquetes.
      "@typescript-eslint/no-namespace": "off",
      // Filtrar caracteres de control (\x00-\x1f) en cabeceras, nombres de archivo y textos es deliberado.
      "no-control-regex": "off",
    },
  },
  // La web corre en el navegador y usa hooks de React.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Scripts de prueba y de integraciones: también corren cosas en el navegador.
  {
    files: ["integrations/**/*.{js,mjs,ts}", "apps/web/e2e/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  // Google Apps Script: todos los .js del proyecto comparten UN scope global (una función de Cards.js se llama
  // desde Hosts.js sin import) y los servicios (CardService, UrlFetchApp…) son globales del runtime. Make también
  // toma las funciones de nivel superior por nombre. no-undef y no-unused-vars no tienen sentido ahí.
  {
    files: ["integrations/connectors/google-workspace/src/**/*.js", "integrations/connectors/make/functions.js"],
    languageOptions: { sourceType: "script" },
    rules: { "no-undef": "off", "@typescript-eslint/no-unused-vars": "off" },
  },
  // App de Zapier: CommonJS (la plataforma hace require del index.js).
  {
    files: ["integrations/connectors/zapier/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    // `const crypto = require("crypto")` pisa el global de Node 19+ a propósito (la plataforma corre Node 18).
    rules: { "@typescript-eslint/no-require-imports": "off", "no-redeclare": ["error", { builtinGlobals: false }] },
  },
  // Widget de Kommo (AMD, `define`) y scripts de Pipedrive/Kommo en ES5: se pegan en la plataforma tal cual.
  {
    files: ["integrations/connectors/kommo/**/*.js", "integrations/connectors/pipedrive/**/*.js"],
    languageOptions: { globals: { define: "readonly", APP: "readonly" } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
  // Complemento de Office: `Office` y `Word` los inyecta office.js.
  {
    files: ["integrations/office/src/**/*.js"],
    languageOptions: { globals: { Office: "readonly", Word: "readonly" } },
  },
  // Service worker de la PWA.
  {
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
