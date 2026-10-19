// CalaSign para Dynamics 365 (apps model-driven: Sales, Customer Service, apps propias de Dataverse).
// Web resource JavaScript (calasign_/commands.js) para botones de la barra de comandos (command designer → acción
// "Run JavaScript", biblioteca calasign_/commands.js, parámetro PrimaryControl):
//   CalaSign.sendForSignature   "Enviar a firmar": marca la fila (calasign_sendforsignature = true) y la guarda; el flujo
//                               de Power Automate "CalaSign: enviar a firmar" crea y envía el sobre con el conector.
//   CalaSign.openEnvelope       "Ver en CalaSign": abre el sobre vinculado (calasign_envelopeid).
//   CalaSign.canSend / canOpen  reglas de visibilidad de los botones (Power Fx o enable rules clásicas).
// No guarda credenciales: la API key de CalaSign vive solo en la conexión del conector.
/* global Xrm */
var CalaSign = (function () {
  "use strict";
  var BASE_URL = "{{BASE_URL}}";
  var RESENDABLE = ["", "declined", "voided", "expired", "error"];

  function attr(form, name) {
    var a = form.getAttribute(name);
    if (!a) throw new Error("Falta la columna " + name + ": corré setup-dataverse.mjs para esta tabla.");
    return a;
  }

  function notify(form, level, text) {
    if (form.ui && form.ui.setFormNotification) form.ui.setFormNotification(text, level, "calasign");
  }

  function statusOf(form) {
    var s = form.getAttribute("calasign_status");
    return (s && s.getValue()) || "";
  }

  function canSend(primaryControl) {
    var form = primaryControl;
    if (!form || !form.getAttribute || !form.getAttribute("calasign_sendforsignature")) return false;
    if (form.ui && form.ui.getFormType && form.ui.getFormType() === 1) return false; // fila sin guardar
    return RESENDABLE.indexOf(statusOf(form)) >= 0;
  }

  function canOpen(primaryControl) {
    var a = primaryControl && primaryControl.getAttribute && primaryControl.getAttribute("calasign_envelopeid");
    return !!(a && a.getValue());
  }

  function sendForSignature(primaryControl) {
    var form = primaryControl;
    var flag, status, prevFlag, prevStatus;
    try {
      if (!canSend(form)) {
        notify(form, "WARNING", "Este registro ya tiene un sobre de CalaSign en curso (" + statusOf(form) + ").");
        return Promise.resolve(false);
      }
      flag = attr(form, "calasign_sendforsignature");
      status = attr(form, "calasign_status");
      prevFlag = flag.getValue();
      prevStatus = status.getValue();
      flag.setValue(true);
      status.setValue("requested");
    } catch (e) {
      notify(form, "ERROR", e.message);
      return Promise.resolve(false);
    }
    return form.data.save().then(
      function () {
        notify(form, "INFO", "Solicitud enviada a CalaSign. El estado se actualiza solo cuando el sobre se envía y se firma.");
        return true;
      },
      function (err) {
        // Sin guardar, la fila quedaba en "requested" en el formulario: el botón se bloqueaba ("sobre en curso") y no
        // se podía reintentar. Se vuelven los valores anteriores para poder corregir y tocar el botón de nuevo.
        flag.setValue(prevFlag);
        status.setValue(prevStatus);
        notify(form, "ERROR", "No se pudo guardar: " + (err && err.message ? err.message : err));
        return false;
      }
    );
  }

  function openEnvelope(primaryControl) {
    var a = primaryControl.getAttribute("calasign_envelopeid");
    var id = a && a.getValue();
    if (!id) {
      notify(primaryControl, "WARNING", "Este registro todavía no tiene un sobre de CalaSign.");
      return false;
    }
    Xrm.Navigation.openUrl(BASE_URL + "/app/envelopes/" + encodeURIComponent(id));
    return true;
  }

  return { sendForSignature: sendForSignature, openEnvelope: openEnvelope, canSend: canSend, canOpen: canOpen, BASE_URL: BASE_URL };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CalaSign;
