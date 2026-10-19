// CalaSign para Kommo: widget con el botón «Enviar a firmar con CalaSign».
// · Ficha del lead (lcard-1): un botón en el panel derecho abre CalaSign con el id del lead.
// · Lista de leads (llist-1): la acción del widget sobre los leads seleccionados (máximo 20).
// La página que se abre (send.html) es del dominio de CalaSign y usa la sesión del navegador: el widget no guarda API
// keys ni tokens. El envío lo hace el conector nativo (POST /v1/crm/mappings/{id}/send) con la conexión OAuth.
define(["jquery"], function ($) {
  var BASE = "{{BASE_URL}}";
  var SEND = BASE + "/integrations/connectors/kommo/send.html";

  var CustomWidget = function () {
    var self = this;

    function open(ids) {
      var clean = [];
      for (var i = 0; i < ids.length && clean.length < 20; i++) {
        var id = String(ids[i]);
        if (/^\d{1,18}$/.test(id) && clean.indexOf(id) < 0) clean.push(id);
      }
      if (!clean.length) return;
      window.open(SEND + "?ids=" + clean.join(","), "_blank", "noopener");
    }

    function currentLead() {
      var card = typeof APP !== "undefined" && APP.data ? APP.data.current_card : null;
      return card && card.id ? String(card.id) : null;
    }

    this.callbacks = {
      render: function () {
        var area = self.system().area;
        // Solo en la ficha de un lead ya creado (no en "nuevo lead").
        if (area !== "lcard" || !currentLead()) return true;
        var L = self.i18n("widget") || {};
        self.render_template({
          caption: { class_name: "calasign-widget" },
          body: "",
          render:
            '<div class="calasign-widget-body">' +
            '<button type="button" class="button-input calasign-send" style="width:100%">' +
            $("<div>").text(L.button || "Enviar a firmar con CalaSign").html() +
            "</button></div>",
        });
        return true;
      },
      init: function () {
        return true;
      },
      bind_actions: function () {
        $(document)
          .off("click.calasign")
          .on("click.calasign", ".calasign-send", function () {
            var id = currentLead();
            if (id) open([id]);
          });
        return true;
      },
      settings: function () {
        return true;
      },
      onSave: function () {
        return true;
      },
      destroy: function () {
        $(document).off("click.calasign");
      },
      leads: {
        selected: function () {
          var sel = (self.list_selected() || {}).selected || [];
          open(
            sel.map(function (x) {
              return x.id;
            }),
          );
        },
      },
    };
    return this;
  };
  return CustomWidget;
});
