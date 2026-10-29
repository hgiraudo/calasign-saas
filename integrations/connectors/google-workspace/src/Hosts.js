// Triggers de cada app: Gmail (correo abierto con PDF adjunto), Docs (documento abierto) y Drive (archivo seleccionado).

// ───────── Gmail ─────────

/** PDF adjuntos de un mensaje (por tipo o por extensión: algunos clientes mandan application/octet-stream). */
function pdfAttachments_(msg) {
  return msg.getAttachments({ includeInlineImages: false, includeAttachments: true }).filter(function (a) {
    return a.getContentType() === "application/pdf" || /\.pdf$/i.test(a.getName() || "");
  });
}

function selfEmail_() {
  try {
    return Session.getActiveUser().getEmail();
  } catch (err) {
    return "";
  }
}

function gmailCard_(e, lang) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var msg = GmailApp.getMessageById(e.gmail.messageId);
  var atts = pdfAttachments_(msg);
  if (!atts.length) return buildMessageCard_(lang, t_(lang, "noPdf"));
  return buildSendCard_(lang, {
    source: "gmail",
    attachments: atts.map(function (a) {
      return a.getName();
    }),
    subject: msg.getSubject() || atts[0].getName().replace(/\.pdf$/i, ""),
    signers: suggestSigners_({ from: msg.getFrom(), to: msg.getTo(), cc: msg.getCc() }, selfEmail_()),
    hasText: false,
    allowSaveBack: false,
    params: { messageId: e.gmail.messageId },
  });
}

/** Trigger contextual: se abre un correo. */
function onGmailMessage(e) {
  return guardCard_(e, function (lang) {
    return gmailCard_(e, lang);
  });
}

// ───────── Docs ─────────

function docsCard_(e, lang) {
  var docs = (e && e.docs) || {};
  if (!docs.id || docs.addonHasFileScopePermission === false) {
    return CardService.newCardBuilder()
      .setName("docs-access")
      .setHeader(header_(lang, t_(lang, "fileAccessTitle")))
      .addSection(
        CardService.newCardSection()
          .addWidget(paragraph_(escapeHtml_(t_(lang, "docAccessText"))))
          .addWidget(
            CardService.newTextButton()
              .setText(t_(lang, "allowAccess"))
              .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
              .setOnClickAction(action_("onRequestDocScope")),
          ),
      )
      .addSection(recentSection_(lang))
      .build();
  }
  var text = driveExport_(docs.id, "text/plain");
  return buildSendCard_(lang, {
    source: "docs",
    docName: docs.title || "Documento",
    subject: docs.title || "",
    signers: [],
    anchors: findAnchors_(text),
    hasText: true,
    allowSaveBack: true,
    top: savedSection_(lang),
    params: { fileId: docs.id },
  });
}

function onDocsHomepage(e) {
  return guardCard_(e, function (lang) {
    return docsCard_(e, lang);
  });
}

/** Docs: el usuario concedió acceso (drive.file) al documento abierto. */
function onDocsFileScopeGranted(e) {
  return guardCard_(e, function (lang) {
    return docsCard_(e, lang);
  });
}

function onRequestDocScope() {
  return CardService.newEditorFileScopeActionResponseBuilder().requestFileScopeForActiveDocument().build();
}

// ───────── Drive ─────────

function driveCard_(e, lang) {
  var items = (e && e.drive && e.drive.selectedItems) || [];
  if (!items.length) return buildHomeCard_(lang, t_(lang, "driveHint"));
  if (items.length > 1) return buildHomeCard_(lang, t_(lang, "driveOne"));
  var it = items[0];
  if (it.mimeType !== "application/pdf" && it.mimeType !== CS_GDOC_MIME)
    return buildHomeCard_(lang, t_(lang, "driveUnsupported", { name: it.title }));
  if (!it.addonHasFileScopePermission) {
    return CardService.newCardBuilder()
      .setName("drive-access")
      .setHeader(header_(lang, t_(lang, "fileAccessTitle")))
      .addSection(
        CardService.newCardSection()
          .addWidget(paragraph_(escapeHtml_(t_(lang, "fileAccessText", { name: it.title }))))
          .addWidget(
            CardService.newTextButton()
              .setText(t_(lang, "allowAccess"))
              .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
              .setOnClickAction(action_("onRequestDriveScope", { fileId: it.id })),
          ),
      )
      .build();
  }
  var isDoc = it.mimeType === CS_GDOC_MIME;
  var text = isDoc ? driveExport_(it.id, "text/plain") : null;
  return buildSendCard_(lang, {
    source: "drive",
    docName: it.title,
    subject: String(it.title || "").replace(/\.pdf$/i, ""),
    signers: [],
    anchors: isDoc ? findAnchors_(text) : null,
    hasText: isDoc,
    allowSaveBack: true,
    top: savedSection_(lang),
    params: { fileId: it.id },
  });
}

function onDriveHomepage(e) {
  return guardCard_(e, function (lang) {
    return buildHomeCard_(lang, t_(lang, "driveHint"));
  });
}

function onDriveItemsSelected(e) {
  return guardCard_(e, function (lang) {
    return driveCard_(e, lang);
  });
}

/** Drive: pide acceso (drive.file) al archivo seleccionado; Drive vuelve a llamar a onDriveItemsSelected. */
function onRequestDriveScope(e) {
  return CardService.newDriveItemsSelectedActionResponseBuilder().requestFileScope(params_(e).fileId).build();
}
