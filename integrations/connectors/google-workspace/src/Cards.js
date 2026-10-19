// Tarjetas (Card Service) comunes: inicio de sesión, inicio, formulario de envío, resultado y sobres recientes.

function header_(lang, title) {
  var logo = CS_BASE_URL + '/integrations/connectors/google-workspace/icon-128.png';
  return CardService.newCardHeader().setTitle(title).setSubtitle(t_(lang, 'tagline')).setImageUrl(logo);
}

function action_(fn, params) {
  var a = CardService.newAction().setFunctionName(fn).setLoadIndicator(CardService.LoadIndicator.SPINNER);
  if (params) a.setParameters(params);
  return a;
}

function paragraph_(text) {
  return CardService.newTextParagraph().setText(text);
}

/** Valor de un campo del formulario (commonEventObject.formInputs, o formInput en eventos viejos). */
function formValue_(e, name) {
  var fi = e && e.commonEventObject && e.commonEventObject.formInputs && e.commonEventObject.formInputs[name];
  if (fi && fi.stringInputs && fi.stringInputs.value && fi.stringInputs.value.length) return fi.stringInputs.value[0];
  if (e && e.formInput && e.formInput[name] !== undefined) return e.formInput[name];
  return '';
}

/** ¿Está marcada la casilla? (un SELECTION_INPUT de tipo CHECK_BOX manda su valor solo si está marcado). */
function formChecked_(e, name) {
  return formValue_(e, name) !== '';
}

function params_(e) {
  return (e && e.commonEventObject && e.commonEventObject.parameters) || (e && e.parameters) || {};
}

function notify_(text) {
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(text)).build();
}

// ───────── Inicio de sesión ─────────

function buildAuthCard_(lang) {
  var login = CardService.newCardSection().addWidget(paragraph_(escapeHtml_(t_(lang, 'loginText'))));
  try {
    var url = getOAuthService_().getAuthorizationUrl();
    login.addWidget(
      CardService.newTextButton()
        .setText(t_(lang, 'loginButton'))
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setAuthorizationAction(CardService.newAuthorizationAction().setAuthorizationUrl(url)),
    );
  } catch (err) {
    login.addWidget(paragraph_(escapeHtml_(t_(lang, 'loginUnavailable', { error: err && err.message ? err.message : String(err) }))));
  }
  var key = CardService.newCardSection()
    .setHeader(t_(lang, 'apiKeyTitle'))
    .setCollapsible(true)
    .addWidget(paragraph_(escapeHtml_(t_(lang, 'apiKeyHelp'))))
    .addWidget(CardService.newTextInput().setFieldName('apiKey').setTitle(t_(lang, 'apiKeyField')))
    .addWidget(CardService.newTextButton().setText(t_(lang, 'apiKeySave')).setOnClickAction(action_('onSaveApiKey')));
  return CardService.newCardBuilder().setName('auth').setHeader(header_(lang, t_(lang, 'loginTitle'))).addSection(login).addSection(key).build();
}

// ───────── Recientes ─────────

function recentSection_(lang) {
  var section = CardService.newCardSection().setHeader(t_(lang, 'recent'));
  var items = listRecentEnvelopes_(8);
  if (!items.length) section.addWidget(paragraph_(escapeHtml_(t_(lang, 'noRecent'))));
  items.forEach(function (env) {
    var when = String(env.completedAt || env.sentAt || env.createdAt || '').slice(0, 10);
    section.addWidget(
      CardService.newDecoratedText()
        .setTopLabel(t_(lang, 'status.' + env.status) + (when ? ' · ' + when : ''))
        .setText(escapeHtml_(env.subject))
        .setWrapText(true)
        .setOpenLink(CardService.newOpenLink().setUrl(envelopeUrl_(env.id))),
    );
  });
  section.addWidget(
    CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText(t_(lang, 'refresh')).setOnClickAction(action_('onRefresh')))
      .addButton(CardService.newTextButton().setText(t_(lang, 'openApp')).setOpenLink(CardService.newOpenLink().setUrl(CS_BASE_URL + '/app'))),
  );
  return section;
}

/** Sección con los firmados que se acaban de guardar en Drive (si hubo). */
function savedSection_(lang) {
  var saved;
  try {
    saved = syncPendingSaves_(lang);
  } catch (err) {
    if (err instanceof CsAuthRequired) throw err;
    console.error(err && err.stack ? err.stack : err);
    return null; // se reintenta la próxima vez
  }
  if (!saved.length) return null;
  var section = CardService.newCardSection().setHeader(t_(lang, 'savedTitle'));
  saved.forEach(function (s) {
    var w = CardService.newDecoratedText().setText(escapeHtml_(t_(lang, s.fallback ? 'savedFallback' : 'savedItem', { name: s.name }))).setWrapText(true);
    if (s.url) w.setOpenLink(CardService.newOpenLink().setUrl(s.url));
    section.addWidget(w);
  });
  return section;
}

/** Tarjeta de inicio: firmados guardados, una indicación según la app y los sobres recientes. */
function buildHomeCard_(lang, hint) {
  var card = CardService.newCardBuilder().setName('home').setHeader(header_(lang, t_(lang, 'appName')));
  var saved = savedSection_(lang);
  if (saved) card.addSection(saved);
  if (hint) card.addSection(CardService.newCardSection().addWidget(paragraph_(escapeHtml_(hint))));
  card.addSection(recentSection_(lang));
  card.addSection(
    CardService.newCardSection().addWidget(CardService.newTextButton().setText(t_(lang, 'signOut')).setOnClickAction(action_('onSignOut'))),
  );
  return card.build();
}

// ───────── Formulario de envío ─────────

/**
 * @param {{source: string, docName?: string, attachments?: string[], subject: string, signers: {name: string, email: string}[],
 *          anchors?: Object<string, string[]>|null, hasText: boolean, allowSaveBack: boolean, top?: Object|null,
 *          params: Object<string, string>}} s  top: sección opcional arriba de todo (firmados recién guardados)
 */
function buildSendCard_(lang, s) {
  var doc = CardService.newCardSection().setHeader(t_(lang, 'document'));
  if (s.attachments && s.attachments.length > 1) {
    var dd = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('attachment').setTitle(t_(lang, 'attachment'));
    s.attachments.forEach(function (name, i) {
      dd.addItem(name, String(i), i === 0);
    });
    doc.addWidget(dd);
  } else if (s.attachments) {
    doc.addWidget(CardService.newDecoratedText().setTopLabel(t_(lang, 'attachment')).setText(escapeHtml_(s.attachments[0])).setWrapText(true));
  } else {
    doc.addWidget(paragraph_(escapeHtml_(t_(lang, 'docAsPdf', { name: s.docName }))));
  }

  var form = CardService.newCardSection()
    .addWidget(CardService.newTextInput().setFieldName('subject').setTitle(t_(lang, 'subject')).setValue(String(s.subject || '').slice(0, 300)))
    .addWidget(
      CardService.newTextInput()
        .setFieldName('signers')
        .setTitle(t_(lang, 'signers'))
        .setHint(t_(lang, 'signersHint'))
        .setMultiline(true)
        .setValue(s.signers.map(formatAddress_).join('\n')),
    )
    .addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('sequential').addItem(t_(lang, 'sequential'), '1', false))
    .addWidget(CardService.newTextInput().setFieldName('message').setTitle(t_(lang, 'message')).setMultiline(true));

  var place = CardService.newCardSection()
    .setHeader(t_(lang, 'placement'))
    .addWidget(
      CardService.newSelectionInput()
        .setType(CardService.SelectionInputType.DROPDOWN)
        .setFieldName('placement')
        .addItem(t_(lang, 'placeAuto'), 'auto', true)
        .addItem(t_(lang, 'placeAnchors'), 'anchors', false)
        .addItem(t_(lang, 'placeLastPage'), 'lastPage', false)
        .addItem(t_(lang, 'placeDraft'), 'draft', false),
    );
  if (s.hasText) {
    var found = [];
    Object.keys(s.anchors || {}).forEach(function (k) {
      found = found.concat(s.anchors[k]);
    });
    place.addWidget(paragraph_(escapeHtml_(found.length ? t_(lang, 'anchorsFound', { list: found.join(', ') }) : t_(lang, 'anchorsNone'))));
  }
  if (s.allowSaveBack) {
    place.addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('saveBack').addItem(t_(lang, 'saveBack'), '1', true));
  }

  var params = { source: s.source, cardKey: Utilities.getUuid() };
  Object.keys(s.params || {}).forEach(function (k) {
    params[k] = String(s.params[k]);
  });
  var card = CardService.newCardBuilder()
    .setName('send')
    .setHeader(header_(lang, t_(lang, 'sendTitle')));
  if (s.top) card.addSection(s.top);
  card
    .addSection(doc)
    .addSection(form)
    .addSection(place)
    .setFixedFooter(CardService.newFixedFooter().setPrimaryButton(CardService.newTextButton().setText(t_(lang, 'send')).setOnClickAction(action_('onSend', params))));
  try {
    card.addSection(recentSection_(lang));
  } catch (err) {
    if (err instanceof CsAuthRequired) throw err;
    /* la lista es secundaria */
  }
  return card.build();
}

/** Tarjeta con un aviso simple (y los recientes). */
function buildMessageCard_(lang, text) {
  return buildHomeCard_(lang, text);
}

function buildResultCard_(lang, r, saveBack) {
  var section = CardService.newCardSection()
    .addWidget(paragraph_(escapeHtml_(r.sent ? t_(lang, 'sentText', { subject: r.subject, n: r.signers }) : t_(lang, 'draftText', { subject: r.subject }))))
    .addWidget(
      CardService.newTextButton()
        .setText(t_(lang, 'openEnvelope'))
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOpenLink(CardService.newOpenLink().setUrl(envelopeUrl_(r.envelopeId))),
    );
  if (saveBack) section.addWidget(paragraph_(escapeHtml_(t_(lang, 'saveBackNote'))));
  return CardService.newCardBuilder()
    .setName('result')
    .setHeader(header_(lang, t_(lang, r.sent ? 'sentTitle' : 'draftTitle')))
    .addSection(section)
    .addSection(recentSection_(lang))
    .build();
}

// ───────── Errores ─────────

/** Texto para el usuario a partir de un error de la API o del formulario. */
function errorText_(lang, err) {
  if (err instanceof CsInputError) return t_(lang, err.code, err.vars);
  if (err instanceof CsApiError) {
    if (err.code === 'anchor_not_found') return t_(lang, 'errAnchorNotFound', { anchor: (err.details && err.details.anchor) || '' });
    if (err.code === 'envelope_incomplete') return t_(lang, 'errIncomplete', { detail: err.message });
    if (err.status === 413 || err.code === 'file_too_large') return t_(lang, 'errTooLarge');
    return t_(lang, 'errApi', { message: err.message });
  }
  return t_(lang, 'errNetwork');
}

/**
 * Ejecuta un trigger que devuelve una tarjeta: sin sesión, la de inicio de sesión; con un error, un aviso.
 */
function guardCard_(e, fn) {
  var lang = langFromEvent_(e);
  try {
    if (!isSignedIn_()) return buildAuthCard_(lang);
    return fn(lang);
  } catch (err) {
    if (err instanceof CsAuthRequired) return buildAuthCard_(lang);
    console.error(err && err.stack ? err.stack : err);
    return CardService.newCardBuilder()
      .setHeader(header_(lang, t_(lang, 'appName')))
      .addSection(CardService.newCardSection().addWidget(paragraph_(escapeHtml_(errorText_(lang, err)))))
      .build();
  }
}

/** Ejecuta una acción: sin sesión, reemplaza la tarjeta por la de inicio de sesión; con un error, una notificación. */
function guardAction_(e, fn) {
  var lang = langFromEvent_(e);
  try {
    return fn(lang);
  } catch (err) {
    if (err instanceof CsAuthRequired) {
      return CardService.newActionResponseBuilder()
        .setNavigation(CardService.newNavigation().updateCard(buildAuthCard_(lang)))
        .setNotification(CardService.newNotification().setText(t_(lang, 'errSession')))
        .build();
    }
    if (!(err instanceof CsInputError) && !(err instanceof CsApiError)) console.error(err && err.stack ? err.stack : err);
    return notify_(errorText_(lang, err));
  }
}

// ───────── Acciones comunes ─────────

/** La tarjeta principal según la app y el contexto del evento (después de iniciar o cerrar sesión). */
function rootCardForEvent_(e, lang) {
  var host = (e && e.commonEventObject && e.commonEventObject.hostApp) || '';
  if (!isSignedIn_()) return buildAuthCard_(lang);
  if (host === 'GMAIL' && e.gmail && e.gmail.messageId) return gmailCard_(e, lang);
  if (host === 'DOCS') return docsCard_(e, lang);
  if (host === 'DRIVE') return driveCard_(e, lang);
  return buildHomeCard_(lang, null);
}

function onSaveApiKey(e) {
  return guardAction_(e, function (lang) {
    if (!saveApiKey_(formValue_(e, 'apiKey'))) return notify_(t_(lang, 'apiKeyInvalid'));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(rootCardForEvent_(e, lang)))
      .setNotification(CardService.newNotification().setText(t_(lang, 'signedIn')))
      .build();
  });
}

function onSignOut(e) {
  return guardAction_(e, function (lang) {
    signOut_();
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildAuthCard_(lang)))
      .setNotification(CardService.newNotification().setText(t_(lang, 'signedOut')))
      .build();
  });
}

/** Acción universal (menú ⋮ del add-on). */
function onSignOutUniversal(e) {
  var lang = langFromEvent_(e);
  signOut_();
  return CardService.newUniversalActionResponseBuilder().displayAddOnCards([buildAuthCard_(lang)]).build();
}

function onRefresh(e) {
  return guardAction_(e, function (lang) {
    return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(rootCardForEvent_(e, lang))).build();
  });
}

/** Página de inicio (Gmail, Calendar y cualquier app sin un homepage propio). */
function onHomepage(e) {
  return guardCard_(e, function (lang) {
    var host = (e && e.commonEventObject && e.commonEventObject.hostApp) || '';
    return buildHomeCard_(lang, host === 'GMAIL' ? t_(lang, 'gmailHint') : null);
  });
}

/**
 * Envío (botón del formulario). Parámetros: source ("gmail" | "docs" | "drive"), cardKey, y messageId o fileId.
 */
function onSend(e) {
  return guardAction_(e, function (lang) {
    var p = params_(e);
    var doc = loadSourceDocument_(e, p);
    var saveBack = !!doc.meta && formChecked_(e, 'saveBack');
    var r = sendDocument_({
      lang: lang,
      cardKey: p.cardKey || Utilities.getUuid(),
      documentName: doc.name,
      pdfBytes: doc.bytes,
      text: doc.text,
      subject: formValue_(e, 'subject'),
      message: formValue_(e, 'message'),
      signersText: formValue_(e, 'signers'),
      sequential: formChecked_(e, 'sequential'),
      placementChoice: formValue_(e, 'placement') || 'auto',
      metadata: doc.metadata,
    });
    if (saveBack) addPendingSave_(r.envelopeId, doc.meta);
    return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(buildResultCard_(lang, r, saveBack))).build();
  });
}

/**
 * El documento a enviar según el origen.
 * @return {{name: string, bytes: number[], text?: string, meta?: Object, metadata: Object}}
 */
function loadSourceDocument_(e, p) {
  if (p.source === 'gmail') {
    if (e.gmail && e.gmail.accessToken) GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
    var msg = GmailApp.getMessageById(p.messageId);
    var atts = pdfAttachments_(msg);
    var att = atts[Number(formValue_(e, 'attachment') || 0)] || atts[0];
    if (!att) throw new CsInputError('errNoDocument');
    return { name: att.getName(), bytes: att.getBytes(), metadata: { source: 'google-workspace-gmail' } };
  }
  if (p.source === 'docs' || p.source === 'drive') {
    var meta = driveMeta_(p.fileId);
    var isDoc = meta.mimeType === CS_GDOC_MIME;
    return {
      name: meta.name,
      bytes: drivePdfBytes_(meta),
      text: isDoc ? driveExport_(meta.id, 'text/plain') : undefined,
      meta: meta,
      metadata: { source: 'google-workspace-' + p.source, driveFileId: meta.id },
    };
  }
  throw new CsInputError('errNoDocument');
}
