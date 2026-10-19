// Registro dinámico de clientes OAuth (RFC 7591) para conectores MCP: validación de metadatos, URIs de redirección
// (https o loopback con cualquier puerto, RFC 8252 §7.3) y el parámetro resource (RFC 8707).
import { beforeAll, describe, expect, it } from "vitest";

let mod: typeof import("../src/modules/oauth");

beforeAll(async () => {
  process.env.APP_URL = "https://dev.calasign.com";
  mod = await import("../src/modules/oauth");
});

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { error?: string }).error;
  }
  return null;
};

describe("registro dinámico", () => {
  it("cliente público por defecto con authorization_code + refresh_token y todos los scopes habilitables", () => {
    const m = mod.parseDcrMetadata({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(m.authMethod).toBe("none");
    expect(m.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(m.responseTypes).toEqual(["code"]);
    expect(m.scopes).toContain("envelopes:read");
  });

  it("acepta loopback http y rechaza http público, esquemas propios y fragmentos", () => {
    expect(mod.parseDcrMetadata({ client_name: "CLI", redirect_uris: ["http://127.0.0.1:33418/callback", "http://localhost/cb", "http://[::1]:9/x"] }).redirectUris).toHaveLength(3);
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: ["http://example.com/cb"] }))).toBe("invalid_redirect_uri");
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: ["com.example.app:/cb"] }))).toBe("invalid_redirect_uri");
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: ["javascript:alert(1)"] }))).toBe("invalid_redirect_uri");
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: ["https://a.example/cb#x"] }))).toBe("invalid_redirect_uri");
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: [] }))).toBe("invalid_redirect_uri");
    expect(err(() => mod.parseDcrMetadata({ client_name: "x", redirect_uris: Array(11).fill("https://a.example/cb") }))).toBe("invalid_redirect_uri");
  });

  it("nunca client_credentials, y valida nombre, response_types, método de autenticación y scopes", () => {
    const base = { client_name: "x", redirect_uris: ["https://a.example/cb"] };
    expect(err(() => mod.parseDcrMetadata({ ...base, grant_types: ["client_credentials"] }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, grant_types: ["authorization_code", "client_credentials"] }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, grant_types: ["refresh_token"] }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, response_types: ["token"] }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, token_endpoint_auth_method: "private_key_jwt" }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, scope: "envelopes:read admin" }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, client_name: "a".repeat(101) }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ redirect_uris: base.redirect_uris }))).toBe("invalid_client_metadata");
    expect(err(() => mod.parseDcrMetadata({ ...base, logo_uri: "http://a.example/logo.png" }))).toBe("invalid_client_metadata");
    const m = mod.parseDcrMetadata({ ...base, client_name: "  Mi\napp ", token_endpoint_auth_method: "client_secret_basic", scope: "envelopes:read offline_access" });
    expect(m.clientName).toBe("Mi app");
    expect(m.scopes).toEqual(["envelopes:read", "offline_access"]);
  });
});

describe("URIs de redirección en la autorización", () => {
  it("coincidencia exacta, salvo el puerto en loopback http", () => {
    const reg = ["https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:7777/oauth/callback", "http://127.0.0.1/callback"];
    expect(mod.redirectUriAllowed(reg, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(mod.redirectUriAllowed(reg, "https://chatgpt.com/connector_platform_oauth_redirect/x")).toBe(false);
    expect(mod.redirectUriAllowed(reg, "http://localhost:51234/oauth/callback")).toBe(true);
    expect(mod.redirectUriAllowed(reg, "http://127.0.0.1:40000/callback")).toBe(true);
    expect(mod.redirectUriAllowed(reg, "http://127.0.0.1:40000/otra")).toBe(false);
    expect(mod.redirectUriAllowed(reg, "http://localhost.evil.com:7777/oauth/callback")).toBe(false);
    expect(mod.redirectUriAllowed(reg, "https://localhost:7777/oauth/callback")).toBe(false);
    expect(mod.redirectUriAllowed(reg, "http://[::1]:7777/oauth/callback")).toBe(false); // otro host de loopback
  });

  it("resource (RFC 8707): solo esta instalación", () => {
    expect(mod.isValidResource("https://dev.calasign.com/mcp")).toBe(true);
    expect(mod.isValidResource("https://dev.calasign.com")).toBe(true);
    expect(mod.isValidResource("https://otro.example/mcp")).toBe(false);
    expect(mod.isValidResource("https://dev.calasign.com/mcpx")).toBe(false);
  });
});
