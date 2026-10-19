// CalaSign para Pipedrive: página de la acción de app (App Extensions → "Link action") «Enviar a firmar con CalaSign».
// Pipedrive la abre en una pestaña nueva desde el detalle o la lista de Deals (o de Persons) con
//   ?resource=deal&view=details&selectedIds=42&userId=…&companyId=…&token=<JWT>
// Como la página es del mismo origen que la API de CalaSign, usa la sesión del navegador (sin API keys ni secretos
// guardados en Pipedrive): lista los mapeos de Pipedrive de la organización y llama a
// POST /v1/crm/mappings/{id}/send por cada registro elegido. El JWT de Pipedrive no se usa ni se envía.
/* eslint-disable no-var */
var CalaSignPipedrive = (function () {
  "use strict";

  var TEXT = {
    es: {
      title: "Enviar a firmar con CalaSign",
      loading: "Cargando…",
      login: "Iniciá sesión en CalaSign en otra pestaña y después tocá «Reintentar».",
      loginLink: "Abrir CalaSign",
      retry: "Reintentar",
      noRecords: "Pipedrive no indicó ningún registro. Abrí esta acción desde un deal o una persona.",
      badResource: "Esta acción funciona desde Deals y Persons.",
      noMappings: "No hay mapeos activos de Pipedrive para este tipo de registro. Crealos en CalaSign → Ajustes → CRM y ERP.",
      mapping: "Mapeo (plantilla)",
      sendNow: "Enviar ya (si no, queda en borrador para revisarlo)",
      records: "Registros",
      submit: "Crear sobre",
      submitMany: "Crear {n} sobres",
      ok: "Sobre creado",
      open: "Ver en CalaSign",
      failed: "No se pudo",
      settings: "Ajustes de CRM",
    },
    en: {
      title: "Send for signature with CalaSign",
      loading: "Loading…",
      login: "Sign in to CalaSign in another tab and then click «Retry».",
      loginLink: "Open CalaSign",
      retry: "Retry",
      noRecords: "Pipedrive did not pass any record. Open this action from a deal or a person.",
      badResource: "This action works from Deals and Persons.",
      noMappings: "There are no active Pipedrive mappings for this record type. Create one in CalaSign → Settings → CRM and ERP.",
      mapping: "Mapping (template)",
      sendNow: "Send now (otherwise it stays as a draft to review)",
      records: "Records",
      submit: "Create envelope",
      submitMany: "Create {n} envelopes",
      ok: "Envelope created",
      open: "Open in CalaSign",
      failed: "Failed",
      settings: "CRM settings",
    },
    pt: {
      title: "Enviar para assinatura com CalaSign",
      loading: "Carregando…",
      login: "Entre no CalaSign em outra aba e depois clique em «Tentar de novo».",
      loginLink: "Abrir o CalaSign",
      retry: "Tentar de novo",
      noRecords: "O Pipedrive não informou nenhum registro. Abra esta ação a partir de um deal ou de uma pessoa.",
      badResource: "Esta ação funciona a partir de Deals e Persons.",
      noMappings: "Não há mapeamentos ativos do Pipedrive para este tipo de registro. Crie um em CalaSign → Configurações → CRM e ERP.",
      mapping: "Mapeamento (modelo)",
      sendNow: "Enviar agora (senão fica como rascunho para revisar)",
      records: "Registros",
      submit: "Criar envelope",
      submitMany: "Criar {n} envelopes",
      ok: "Envelope criado",
      open: "Ver no CalaSign",
      failed: "Falhou",
      settings: "Configurações de CRM",
    },
  };

  function lang(nav) {
    var l = String((nav && nav.language) || "es").toLowerCase();
    return l.indexOf("pt") === 0 ? "pt" : l.indexOf("en") === 0 ? "en" : "es";
  }

  /** Parámetros de la acción de Pipedrive → tipo de registro de CalaSign e ids (máximo 20 por vez). */
  function parseParams(search) {
    var q = new URLSearchParams(search || "");
    var resource = (q.get("resource") || "").toLowerCase();
    var objectType = resource === "deal" ? "deal" : resource === "person" ? "contact" : null;
    var ids = (q.get("selectedIds") || q.get("id") || "")
      .split(",")
      .map(function (x) {
        return x.trim();
      })
      .filter(function (x) {
        return /^\d{1,18}$/.test(x);
      });
    var seen = {};
    ids = ids.filter(function (x) {
      return seen[x] ? false : (seen[x] = true);
    });
    return { resource: resource, objectType: objectType, ids: ids.slice(0, 20), truncated: ids.length > 20, companyId: /^\d{1,18}$/.test(q.get("companyId") || "") ? q.get("companyId") : null };
  }

  /** Mapeos activos con plantilla para ese tipo de registro (la API ya filtra por conexiones activas de Pipedrive). */
  function eligibleMappings(mappings, objectType) {
    return (mappings || [])
      .filter(function (m) {
        return m.active && m.objectType === objectType && m.templateId;
      })
      .map(function (m) {
        return { id: m.id, name: m.name, send: m.send !== false };
      });
  }

  function apiFactory(fetchImpl, base) {
    return function (method, path, body) {
      return fetchImpl(base + path, {
        method: method,
        credentials: "include",
        headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var err = new Error((data && data.error && data.error.message) || "HTTP " + res.status);
            err.status = res.status;
            err.code = data && data.error && data.error.code;
            throw err;
          }
          return data;
        });
      });
    };
  }

  /** Crea un sobre por registro, uno tras otro (el límite de la API es por minuto). companyId: la compañía de
   *  Pipedrive desde la que se abrió la acción; la API rechaza (409 company_mismatch) un mapeo de otra compañía. */
  function sendAll(api, mappingId, ids, send, companyId) {
    var out = [];
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return api("POST", "/v1/crm/mappings/" + encodeURIComponent(mappingId) + "/send", companyId ? { objectId: id, send: send, companyId: companyId } : { objectId: id, send: send }).then(
          function (r) {
            out.push({ id: id, ok: true, envelopeId: r.envelopeId, status: r.status });
          },
          function (e) {
            out.push({ id: id, ok: false, error: e.message, code: e.code || null });
          },
        );
      });
    });
    return chain.then(function () {
      return out;
    });
  }

  /** Carga los mapeos de Pipedrive con la sesión del navegador. Devuelve { state: "login" | "ready" | "error", … }. */
  function load(api, params) {
    if (!params.objectType) return Promise.resolve({ state: "error", key: "badResource" });
    if (!params.ids.length) return Promise.resolve({ state: "error", key: "noRecords" });
    // Con companyId solo vienen los mapeos de la conexión de ESA compañía (con dos compañías conectadas, un mapeo de la
    // otra leería un deal ajeno con el mismo id).
    return api("GET", "/v1/crm/mappings?provider=pipedrive" + (params.companyId ? "&companyId=" + encodeURIComponent(params.companyId) : ""))
      .then(function (r) {
        var maps = eligibleMappings(r.items, params.objectType);
        return maps.length ? { state: "ready", mappings: maps } : { state: "error", key: "noMappings" };
      })
      .catch(function (e) {
        if (e.status === 401) return { state: "login" };
        return { state: "error", message: e.message };
      });
  }

  // ───────── Interfaz ─────────

  function el(doc, tag, attrs, children) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) n.appendChild(c);
    });
    return n;
  }

  function mount(win) {
    var doc = win.document;
    var T = TEXT[lang(win.navigator)];
    var base = win.location.origin;
    var api = apiFactory(win.fetch.bind(win), base);
    var params = parseParams(win.location.search);
    var root = doc.getElementById("app");
    doc.title = T.title;
    doc.documentElement.lang = lang(win.navigator);

    function render(nodes) {
      while (root.firstChild) root.removeChild(root.firstChild);
      nodes.forEach(function (n) {
        root.appendChild(n);
      });
    }
    function head() {
      return el(doc, "h1", { text: T.title });
    }

    function start() {
      render([head(), el(doc, "p", { class: "muted", text: T.loading })]);
      load(api, params).then(function (r) {
        if (r.state === "login") {
          var retry = el(doc, "button", { type: "button", text: T.retry });
          retry.addEventListener("click", start);
          render([head(), el(doc, "p", { text: T.login }), el(doc, "p", {}, [el(doc, "a", { href: base + "/login", target: "_blank", rel: "noopener", text: T.loginLink })]), retry]);
          return;
        }
        if (r.state === "error") {
          var parts = [head(), el(doc, "p", { class: "error", text: r.key ? T[r.key] : r.message })];
          if (r.key === "noMappings") parts.push(el(doc, "p", {}, [el(doc, "a", { href: base + "/app/settings/crm", target: "_blank", rel: "noopener", text: T.settings })]));
          render(parts);
          return;
        }
        form(r.mappings);
      });
    }

    function form(maps) {
      var select = el(doc, "select", { id: "mapping" });
      maps.forEach(function (m) {
        select.appendChild(el(doc, "option", { value: m.id, text: m.name }));
      });
      var sendNow = el(doc, "input", { type: "checkbox", id: "send-now" });
      sendNow.checked = maps[0].send;
      select.addEventListener("change", function () {
        var m = maps.filter(function (x) {
          return x.id === select.value;
        })[0];
        if (m) sendNow.checked = m.send;
      });
      // Registros que todavía no tienen sobre: volver a tocar el botón (p. ej. tras un error en alguno) reintenta solo
      // esos. Antes reenviaba todos y los que ya habían salido recibían un segundo sobre.
      var pending = params.ids.slice();
      var labelFor = function (n) {
        return n > 1 ? T.submitMany.replace("{n}", String(n)) : T.submit;
      };
      var btn = el(doc, "button", { type: "submit", class: "primary", text: labelFor(pending.length) });
      var results = el(doc, "ul", { class: "results" });
      var f = el(doc, "form", {}, [
        el(doc, "label", { for: "mapping", text: T.mapping }),
        select,
        el(doc, "label", { class: "check" }, [sendNow, doc.createTextNode(" " + T.sendNow)]),
        el(doc, "p", { class: "muted", text: T.records + ": " + params.ids.join(", ") }),
        btn,
      ]);
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!pending.length) return;
        btn.disabled = true;
        sendAll(api, select.value, pending, sendNow.checked, params.companyId).then(function (out) {
          out.forEach(function (o) {
            var li = el(doc, "li", { class: o.ok ? "ok" : "error" });
            li.appendChild(doc.createTextNode("#" + o.id + " — " + (o.ok ? T.ok + " (" + o.status + ") " : T.failed + ": " + o.error)));
            if (o.ok) li.appendChild(el(doc, "a", { href: base + "/app/envelopes/" + encodeURIComponent(o.envelopeId), target: "_blank", rel: "noopener", text: T.open }));
            results.appendChild(li);
          });
          pending = out
            .filter(function (o) {
              return !o.ok;
            })
            .map(function (o) {
              return o.id;
            });
          btn.textContent = labelFor(pending.length);
          btn.disabled = pending.length === 0;
        });
      });
      render([head(), f, results]);
    }

    start();
  }

  if (typeof window !== "undefined" && window.document && window.document.getElementById("app")) mount(window);

  return { parseParams: parseParams, eligibleMappings: eligibleMappings, apiFactory: apiFactory, sendAll: sendAll, load: load, lang: lang, TEXT: TEXT };
})();
if (typeof module !== "undefined") module.exports = CalaSignPipedrive;
