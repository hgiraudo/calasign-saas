// Entrada de la API para pruebas que levantan su propio proceso (e2e-crm): el nombre no contiene
// "server.ts", así un pkill/pgrep por ese patrón no mata a esta instancia.
await import("../apps/api/src/server.ts");
