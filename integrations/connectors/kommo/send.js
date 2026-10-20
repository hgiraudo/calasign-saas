// CalaSign para Kommo: página que abre el widget («Enviar a firmar con CalaSign») con ?ids=<lead>[,<lead>…].
// Es del mismo origen que la API de CalaSign y usa la sesión del navegador (sin API keys guardadas en Kommo): lista
// los mapeos de Kommo de la organización y llama a POST /v1/crm/mappings/{id}/send por cada lead elegido.
/* eslint-disable no-var */
var CalaSignKommo = (function () {
  "use strict";

  var TEXT = {
    es: {
      title: "Enviar a firmar con CalaSign",
      loading: "Cargando…",
      login: "Iniciá sesión en CalaSign en otra pestaña y después tocá «Reintentar».",
      loginLink: "Abrir CalaSign",
      retry: "Reintentar",
      noRecords: "Kommo no indicó ningún lead. Abrí el widget desde la ficha o la lista de leads.",
      noMappings: "No hay mapeos activos de Kommo para leads. Crealos en CalaSign → Ajustes → CRM y ERP.",
      noAccount: "Kommo no indicó desde qué cuenta se abrió el widget, así que no se ofrecen mapeos (podrían ser de otra cuenta). Volvé a abrirlo desde Kommo o actualizá el widget.",
      accountUnknown: "Hay conexiones de Kommo sin su cuenta guardada: sus mapeos no aparecen. Probá la conexión en CalaSign → Ajustes → CRM y ERP para habilitarla.",
      mapping: "Mapeo (plantilla)",
      sendNow: "Enviar ya (si no, queda en borrador para revisarlo)",
      records: "Leads",
      submit: "Crear sobre",
      submitMany: "Crear {n} sobres",
      ok: "Sobre creado",
      open: "Ver en CalaSign",
      failed: "No se pudo",
      settings: "Ajustes de CRM",
      truncated: "Kommo mandó {total} leads y se envían como máximo 20 por vez: {n} quedan SIN enviar. Después, volvé a abrir el widget con los restantes.",
    },
    en: {
      title: "Send for signature with CalaSign",
      loading: "Loading…",
      login: "Sign in to CalaSign in another tab and then click «Retry».",
      loginLink: "Open CalaSign",
      retry: "Retry",
      noRecords: "Kommo did not pass any lead. Open the widget from a lead card or the leads list.",
      noMappings: "There are no active Kommo mappings for leads. Create one in CalaSign → Settings → CRM and ERP.",
      noAccount: "Kommo did not say which account the widget was opened from, so no mappings are offered (they could belong to another account). Open it again from Kommo or update the widget.",
      accountUnknown: "Some Kommo connections have no stored account: their mappings are not shown. Test the connection in CalaSign → Settings → CRM and ERP to enable it.",
      mapping: "Mapping (template)",
      sendNow: "Send now (otherwise it stays as a draft to review)",
      records: "Leads",
      submit: "Create envelope",
      submitMany: "Create {n} envelopes",
      ok: "Envelope created",
      open: "Open in CalaSign",
      failed: "Failed",
      settings: "CRM settings",
      truncated: "Kommo passed {total} leads and at most 20 are sent at a time: {n} will NOT be sent. Afterwards, open the widget again with the remaining ones.",
    },
    pt: {
      title: "Enviar para assinatura com CalaSign",
      loading: "Carregando…",
      login: "Entre no CalaSign em outra aba e depois clique em «Tentar de novo».",
      loginLink: "Abrir o CalaSign",
      retry: "Tentar de novo",
      noRecords: "O Kommo não informou nenhum lead. Abra o widget a partir da ficha ou da lista de leads.",
      noMappings: "Não há mapeamentos ativos do Kommo para leads. Crie um em CalaSign → Configurações → CRM e ERP.",
      noAccount: "O Kommo não informou de qual conta o widget foi aberto, então nenhum mapeamento é oferecido (poderiam ser de outra conta). Abra-o de novo a partir do Kommo ou atualize o widget.",
      accountUnknown: "Há conexões do Kommo sem a conta salva: os mapeamentos delas não aparecem. Teste a conexão em CalaSign → Configurações → CRM e ERP para habilitá-la.",
      mapping: "Mapeamento (modelo)",
      sendNow: "Enviar agora (senão fica como rascunho para revisar)",
      records: "Leads",
      submit: "Criar envelope",
      submitMany: "Criar {n} envelopes",
      ok: "Envelope criado",
      open: "Ver no CalaSign",
      failed: "Falhou",
      settings: "Configurações de CRM",
      truncated: "O Kommo enviou {total} leads e no máximo 20 são enviados por vez: {n} NÃO serão enviados. Depois, abra o widget de novo com os restantes.",
    },
  };

  function lang(nav) {
    var l = String((nav && nav.language) || "es").toLowerCase();
    return l.indexOf("pt") === 0 ? "pt" : l.indexOf("en") === 0 ? "en" : "es";
  }

  /** ?ids=1,2&companyId=<cuenta> → ids numéricos sin repetir (máximo 20) y la cuenta de Kommo del widget. */
  function parseParams(search) {
    var q = new URLSearchParams(search || "");
    var seen = {};
    var ids = (q.get("ids") || "")
      .split(",")
      .map(function (x) {
        return x.trim();
      })
      .filter(function (x) {
        if (!/^\d{1,18}$/.test(x) || seen[x]) return false;
        return (seen[x] = true);
      });
    var company = q.get("companyId") || "";
    // total: los leads elegidos en Kommo cuando el widget pasó solo los primeros 200 (por el largo de la URL).
    var total = Math.max(ids.length, /^\d{1,6}$/.test(q.get("total") || "") ? Number(q.get("total")) : 0);
    return { ids: ids.slice(0, 20), truncated: total > 20, total: total, skipped: Math.max(0, total - 20), companyId: /^\d{1,18}$/.test(company) ? company : null };
  }

  /** Mapeos activos de leads (objectType deal) con plantilla. */
  function eligibleMappings(mappings) {
    return (mappings || [])
      .filter(function (m) {
        return m.active && m.objectType === "deal" && m.templateId;
      })
      .map(function (m) {
        return { id: m.id, name: m.name, send: m.send !== false };
      });
  }

  /**
   * Idempotency-Key de cada envío, estable por registro y por corrida de la página: si un envío vuelve con 504 (el
   * sobre pudo crearse igual) y se reintenta, la API devuelve el mismo sobre en lugar de crear otro.
   */
  function idempotencyKey(companyId, mappingId, recordId, runId) {
    return "km-" + (companyId || "x") + "-" + mappingId + "-" + recordId + "-" + runId;
  }

  /** Id de la corrida: se genera al abrir la página y se guarda en sessionStorage (por URL), así recargar la pestaña
   *  después de un error de red reutiliza las mismas claves. */
  function runIdFor(win) {
    var key = "calasign-kommo-run:" + win.location.search;
    var fresh = function () {
      return win.crypto && win.crypto.randomUUID ? win.crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    };
    try {
      var v = win.sessionStorage.getItem(key);
      if (!v) {
        v = fresh();
        win.sessionStorage.setItem(key, v);
      }
      return v;
    } catch (e) {
      return fresh();
    }
  }

  function apiFactory(fetchImpl, base) {
    return function (method, path, body, extraHeaders) {
      return fetchImpl(base + path, {
        method: method,
        credentials: "include",
        headers: Object.assign(body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" }, extraHeaders || {}),
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

  /** Un sobre por lead, uno tras otro (el límite de la API es por minuto). Se manda companyId (la cuenta del widget):
   *  la API rechaza (409 company_mismatch) un mapeo de la conexión de otra cuenta. */
  function sendAll(api, mappingId, ids, send, companyId, runId) {
    var out = [];
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return api("POST", "/v1/crm/mappings/" + encodeURIComponent(mappingId) + "/send", companyId ? { objectId: id, send: send, companyId: companyId } : { objectId: id, send: send }, runId ? { "Idempotency-Key": idempotencyKey(companyId, mappingId, id, runId) } : null).then(
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

  function load(api, params) {
    if (!params.ids.length) return Promise.resolve({ state: "error", key: "noRecords" });
    // Sin la cuenta de Kommo desde la que se abrió el widget no se ofrecen mapeos: con dos cuentas conectadas, un mapeo
    // de la otra leería un lead ajeno con el mismo id (la API, sin companyId, usaría la cuenta de la conexión del mapeo).
    if (!params.companyId) return Promise.resolve({ state: "error", key: "noAccount" });
    return api("GET", "/v1/crm/mappings?provider=kommo&companyId=" + encodeURIComponent(params.companyId))
      .then(function (r) {
        var maps = eligibleMappings(r.items);
        // Conexiones sin su cuenta guardada: sus mapeos no se listan con companyId; se avisa que hay que probarlas.
        var accountUnknown = !!(r.connectionsWithoutAccount && r.connectionsWithoutAccount.length);
        if (!maps.length) return { state: "error", key: accountUnknown ? "accountUnknown" : "noMappings" };
        return { state: "ready", mappings: maps, accountUnknown: accountUnknown };
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
    var runId = runIdFor(win);
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
          if (r.key === "noMappings" || r.key === "accountUnknown") parts.push(el(doc, "p", {}, [el(doc, "a", { href: base + "/app/settings/crm", target: "_blank", rel: "noopener", text: T.settings })]));
          render(parts);
          return;
        }
        form(r.mappings, r.accountUnknown);
      });
    }

    function form(maps, accountUnknown) {
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
      // Leads que todavía no tienen sobre: volver a tocar el botón (p. ej. tras un error en alguno) reintenta solo esos
      // (como en Pipedrive). Antes reenviaba todos y, con otro mapeo elegido, los que ya habían salido recibían otro sobre.
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
        // Tope de 20 por vez: se avisa cuántos quedan afuera (antes se cortaba sin decir nada).
        params.skipped ? el(doc, "p", { class: "error", role: "alert", text: T.truncated.replace("{total}", String(params.total)).replace("{n}", String(params.skipped)) }) : null,
        el(doc, "p", { class: "muted", text: T.records + ": " + params.ids.join(", ") }),
        accountUnknown ? el(doc, "p", { class: "muted", role: "status", text: T.accountUnknown }) : null,
        btn,
      ]);
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!pending.length) return;
        btn.disabled = true;
        sendAll(api, select.value, pending, sendNow.checked, params.companyId, runId).then(function (out) {
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

  return { parseParams: parseParams, eligibleMappings: eligibleMappings, apiFactory: apiFactory, sendAll: sendAll, load: load, lang: lang, idempotencyKey: idempotencyKey, runIdFor: runIdFor, TEXT: TEXT };
})();
if (typeof module !== "undefined") module.exports = CalaSignKommo;
