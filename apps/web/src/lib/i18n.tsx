// i18n mínimo: diccionarios planos es / pt-BR / en.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "@calasign/shared";
import { prodEn, prodEs, prodPt, type ProdKey } from "./i18n-productivity";
import { brandText, useBrandVersion } from "./white-label";
import { interpolate, pluralize } from "./interpolate";

const es = {
  "app.name": "CalaSign",
  "common.save": "Guardar",
  "common.saving": "Guardando…",
  "common.cancel": "Cancelar",
  "common.delete": "Eliminar",
  "common.back": "Volver",
  "common.next": "Siguiente",
  "common.loading": "Cargando…",
  "common.close": "Cerrar",
  "common.copy": "Copiar",
  "common.copied": "Copiado",
  "common.refresh": "Actualizar",
  "common.optional": "opcional",
  "common.error": "Ocurrió un error",
  "common.language": "Idioma",
  "common.none": "—",
  "common.confirmAction": "¿Seguro? Esta acción no se puede deshacer.",
  "common.needsViewAll": "Solo lectura: cambiar estos ajustes requiere además el permiso de ver todos los sobres de la organización.",
  "common.notInPlan": "No incluido en tu plan ({plan}): podés ver, pausar o quitar lo que ya está configurado, pero no crear ni activar nada nuevo.",
  "common.seePlans": "Ver planes",
  "common.askAdminPlan": "Pedile a un administrador de tu organización que revise el plan.",
  "common.notInPlanShort": "No incluido en tu plan",

  "nav.envelopes": "Sobres",
  "nav.apiKeys": "API keys",
  "nav.mailbox": "Buzón dev",
  "nav.logout": "Salir",
  "nav.menu": "Menú",

  "auth.login": "Ingresar",
  "auth.signup": "Crear cuenta",
  "auth.email": "Email",
  "auth.password": "Contraseña",
  "auth.passwordHint": "Mínimo 10 caracteres",
  "auth.name": "Tu nombre",
  "auth.organization": "Organización",
  "auth.noAccount": "¿No tenés cuenta?",
  "auth.haveAccount": "¿Ya tenés cuenta?",
  "auth.tagline": "Firma electrónica en la nube para Latinoamérica",

  "status.draft": "Borrador",
  "status.sent": "En curso",
  "status.finalizing": "Finalizando",
  "status.awaiting_certificates": "Esperando certificados",
  "status.completed": "Completado",
  "status.declined": "Rechazado",
  "status.voided": "Anulado",
  "status.expired": "Vencido",
  "status.all": "Todos",

  "rstatus.created": "Pendiente",
  "rstatus.sent": "Enviado",
  "rstatus.viewed": "Visto",
  "rstatus.signed": "Firmó",
  "rstatus.declined": "Rechazó",
  "rstatus.completed": "Recibió copia",
  "rstatus.delegated": "Delegó",
  "rstatus.reassigned": "Reasignado",

  "list.title": "Sobres",
  "list.new": "Nuevo sobre",
  "list.search": "Buscar por asunto…",
  "list.empty": "Todavía no hay sobres.",
  "list.subject": "Asunto",
  "list.recipients": "Destinatarios",
  "list.status": "Estado",
  "list.created": "Creado",
  "list.loadMore": "Cargar más",
  "list.newSubject": "Asunto del sobre",
  "list.create": "Crear",

  "edit.title": "Preparar sobre",
  "edit.step.documents": "Documentos",
  "edit.step.recipients": "Destinatarios",
  "edit.step.fields": "Campos",
  "edit.step.review": "Revisar y enviar",
  "edit.upload": "Subir PDF",
  "edit.uploading": "Subiendo…",
  "edit.dropHint": "Subí uno o más PDF. Se firman en el orden de la lista.",
  "edit.pages": "págs.",
  "edit.noDocuments": "Todavía no hay documentos.",
  "edit.hadSignatures":
    "{names}: el archivo traía firmas digitales. Al subirlo se sanea (formularios aplanados, contenido activo y adjuntos eliminados) y esas firmas se pierden: el documento guardado y el PDF final no las conservan.",
  "edit.formAppearanceMismatch":
    "{names}: el formulario pedía que el lector redibujara los campos y alguno no se pudo redibujar. Quedó fijado como estaba guardado en el archivo, que otro programa podría mostrar distinto: revisá el documento antes de enviarlo.",
  "edit.addRecipient": "Agregar destinatario",
  "edit.role": "Rol",
  "edit.role.signer": "Firmante",
  "edit.role.cc": "Copia",
  "edit.role.approver": "Aprobador",
  "edit.order": "Orden",
  "edit.orderHint": "Mismo número = firman en paralelo; distinto = en secuencia.",
  "edit.name": "Nombre",
  "edit.phone": "Teléfono (E.164)",
  "edit.channels": "Canales",
  "edit.locale": "Idioma",
  "edit.idType": "Documento",
  "edit.idNumber": "Número",
  "edit.telegramChatId": "Telegram chat ID",
  "edit.telegramHint": "Opcional: si queda vacío, el firmante vincula Telegram desde la invitación.",
  // Edición concurrente, salida con cambios sin guardar y validación de campos en los editores
  "common.unsavedLeave": "Hay cambios sin guardar. ¿Salir igual y descartarlos?",
  "edit.versionChanged": "Este borrador cambió en otra pestaña o lo editó otra persona. Recargá para ver la versión actual.",
  "edit.reload": "Recargar",
  "edit.reloadConfirm": "Al recargar se descartan los cambios sin guardar de esta pestaña. ¿Continuar?",
  "edit.roleDropsFields": "{name} tiene {n} campo(s) en el documento. Si deja de ser firmante, esos campos se eliminan al guardar. ¿Continuar?",
  "edit.err.field": "{field} (página {page}): {msg}",
  "edit.err.dropdownOptions": "el desplegable necesita al menos una opción.",
  "edit.err.minMax": "el mínimo no puede ser mayor que el máximo.",
  "edit.err.readOnlyValue": "un campo de solo lectura necesita un valor prellenado.",
  "edit.err.prefillOption": "el valor prellenado no es una de las opciones.",
  "edit.err.formula": "la fórmula no es válida.",
  "edit.err.formulaRef": "la fórmula cita {ref}, que no es la etiqueta de otro campo número.",
  "edit.err.formulaDupLabel": "hay dos campos número con la etiqueta {label} y la fórmula la usa.",
  "edit.err.condition": "una condición cita un campo que no existe o al mismo campo.",
  "edit.err.conditionValue": "a una condición le falta el valor a comparar.",
  "edit.fieldKeysHint": "Con el teclado: elegí un tipo de campo y la página y tocá \"Agregar a la página\" (queda en el centro de la parte visible); Tab llega a cada campo, Enter lo selecciona, las flechas lo mueven, Shift + flechas cambian el tamaño y Supr lo elimina.",
  "detail.telegramLinked": "Telegram vinculado",
  "detail.telegramPending": "Telegram sin vincular",
  "sign.telegram": "Recibir avisos por Telegram",
  "edit.noRecipients": "Agregá al menos un firmante.",
  "edit.palette": "Arrastrá o hacé clic en la página para ubicar",
  "edit.activeRecipient": "Campos para",
  "edit.required": "Obligatorio",
  "edit.label": "Etiqueta",
  "edit.fieldFor": "Firmante",
  "edit.selectFieldHint": "Elegí un tipo de campo y hacé clic sobre la página.",
  "edit.noSigners": "Primero agregá firmantes.",
  "edit.subject": "Asunto",
  "edit.message": "Mensaje",
  "edit.expires": "Vence el",
  "edit.send": "Enviar",
  "edit.sending": "Enviando…",
  "edit.summary": "Resumen",
  "edit.fieldsCount": "{n} campo|{n} campos",
  "edit.placePage": "Página donde agregarlo",
  "edit.pageN": "Página {page}",
  "edit.addToPage": "Agregar a la página {page}",
  "edit.saved": "Guardado",

  "field.signature": "Firma",
  "field.initials": "Iniciales",
  "field.date_signed": "Fecha de firma",
  "field.name": "Nombre",
  "field.email": "Email",
  "field.text": "Texto",
  "field.checkbox": "Casilla",

  "detail.recipients": "Destinatarios",
  "detail.timeline": "Registro de auditoría",
  "detail.download": "Descargar PDF firmado",
  "detail.void": "Anular",
  "detail.voidReason": "Motivo de la anulación",
  "detail.remind": "Reenviar aviso",
  "detail.reminded": "Avisos reenviados",
  "detail.edit": "Editar borrador",
  "detail.documents": "Documentos",
  "detail.hash": "Hash",
  "detail.sent": "Enviado",
  "detail.viewed": "Visto",
  "detail.signed": "Firmado",
  "detail.declined": "Rechazado",
  "detail.declineReason": "Motivo",
  "detail.voidedReason": "Anulado:",
  "detail.sha": "SHA-256 del PDF final",
  "detail.finalizeFailed": "No se pudo terminar de sellar el documento. Podés reintentarlo; si vuelve a fallar, contactá a soporte.",
  "detail.finalizeFailedUnsealable":
    "El documento no se puede sellar (código {code}). Reintentar no lo resuelve: anulá el sobre y envialo de nuevo (con el PDF exportado de nuevo o impreso a PDF).",
  "detail.retryFinalize": "Reintentar finalización",
  "detail.finalizeRetried": "Reintento en curso",

  "keys.title": "API keys",
  "keys.intro": "Usá una API key para integrar CalaSign desde tu sistema: Authorization: Bearer <key>.",
  "keys.name": "Nombre",
  "keys.create": "Crear API key",
  "keys.secretOnce": "Copiá la clave ahora: no se vuelve a mostrar.",
  "keys.revoke": "Revocar",
  "keys.revoked": "Revocada",
  "keys.lastUsed": "Último uso",
  "keys.empty": "No hay API keys.",

  "sign.consentTitle": "Antes de empezar",
  "sign.consentText":
    "Acepto firmar electrónicamente y recibir los documentos por medios electrónicos. Entiendo que mi firma electrónica tiene la misma validez que mi firma manuscrita, y que se registrarán la fecha, la hora, mi dirección IP y mi dispositivo como evidencia.",
  "sign.consentAccept": "Acepto y continúo",
  "sign.sentBy": "te envió para firmar",
  "sign.progress": "{done} de {total} campos",
  "sign.nextField": "Siguiente campo",
  "sign.finish": "Finalizar",
  "sign.finishing": "Firmando…",
  "sign.decline": "Rechazar",
  "sign.declineTitle": "Rechazar el documento",
  "sign.declineReason": "Contale al remitente por qué",
  "sign.declineConfirm": "Rechazar",
  "sign.adoptTitle": "Adoptá tu firma",
  "sign.adoptInitials": "Adoptá tus iniciales",
  "sign.draw": "Dibujar",
  "sign.type": "Escribir",
  "sign.clear": "Borrar",
  "sign.adopt": "Adoptar y firmar",
  "sign.drawHere": "Dibujá tu firma acá",
  "sign.typeHere": "Escribí tu nombre",
  "sign.clickToSign": "Firmar",
  "sign.missing": "Completá los campos obligatorios",
  "sign.doneTitle": "¡Listo! Firmaste el documento",
  "sign.doneText": "Cuando todos firmen vas a recibir una copia del documento final.",
  "sign.doneTextDownload": "Guardá el link de esta página: cuando todos firmen vas a poder descargar el documento final desde acá (no te lo mandamos por correo porque no validaste tu dirección).",
  "sign.doneAvailable": "El documento está completo y sellado.",
  "sign.downloadSigned": "Descargar documento firmado",
  "sign.downloadCopy": "Descargar copia con tu firma",
  "sign.copyNote": "Es una copia de lo firmado hasta ahora. El documento final sellado va a estar disponible acá cuando terminen todos.",
  "sign.sealing": "Todos firmaron. Estamos sellando el documento final: en unos segundos vas a poder descargarlo acá.",
  "sign.declinedTitle": "Rechazaste el documento",
  "sign.declinedText": "Le avisamos al remitente.",
  "sign.notYourTurnTitle": "Todavía no es tu turno",
  "sign.notYourTurnText": "Te vamos a avisar cuando los firmantes anteriores terminen.",
  "sign.voidedTitle": "Este sobre fue anulado",
  "sign.expiredTitle": "Este sobre venció",
  "sign.closedText": "Ya no se puede firmar. Contactá al remitente si tenés dudas.",
  "sign.declinedByOtherTitle": "Este sobre fue rechazado",
  "sign.ccTitle": "Recibiste una copia",
  "sign.ccText": "No tenés que firmar nada. Podés revisar los documentos.",
  "sign.invalidTitle": "Link inválido o vencido",
  "sign.invalidText": "Pedile al remitente que te reenvíe el sobre.",
  "sign.autoField": "se completa al firmar",
  "sign.poweredBy": "Firma electrónica segura con CalaSign",

  "mailbox.title": "Buzón de desarrollo",
  "mailbox.intro": "Mensajes que el servidor habría enviado por email o WhatsApp.",
  "mailbox.empty": "No hay mensajes.",
  "mailbox.open": "Abrir link",
} as const;

export type MessageKey = keyof typeof es | ProdKey;
type Dict = Record<keyof typeof es, string>;

const ptBR: Dict = {
  "app.name": "CalaSign",
  "common.save": "Salvar",
  "common.saving": "Salvando…",
  "common.cancel": "Cancelar",
  "common.delete": "Excluir",
  "common.back": "Voltar",
  "common.next": "Próximo",
  "common.loading": "Carregando…",
  "common.close": "Fechar",
  "common.copy": "Copiar",
  "common.copied": "Copiado",
  "common.refresh": "Atualizar",
  "common.optional": "opcional",
  "common.error": "Ocorreu um erro",
  "common.language": "Idioma",
  "common.none": "—",
  "common.confirmAction": "Tem certeza? Esta ação não pode ser desfeita.",
  "common.needsViewAll": "Somente leitura: alterar estas configurações requer também a permissão de ver todos os envelopes da organização.",
  "common.notInPlan": "Não incluído no seu plano ({plan}): você pode ver, pausar ou remover o que já está configurado, mas não criar nem ativar nada novo.",
  "common.seePlans": "Ver planos",
  "common.askAdminPlan": "Peça a um administrador da sua organização para revisar o plano.",
  "common.notInPlanShort": "Não incluído no seu plano",
  "nav.envelopes": "Envelopes",
  "nav.apiKeys": "API keys",
  "nav.mailbox": "Caixa dev",
  "nav.logout": "Sair",
  "nav.menu": "Menu",
  "auth.login": "Entrar",
  "auth.signup": "Criar conta",
  "auth.email": "E-mail",
  "auth.password": "Senha",
  "auth.passwordHint": "Mínimo de 10 caracteres",
  "auth.name": "Seu nome",
  "auth.organization": "Organização",
  "auth.noAccount": "Não tem conta?",
  "auth.haveAccount": "Já tem conta?",
  "auth.tagline": "Assinatura eletrônica na nuvem para a América Latina",
  "status.draft": "Rascunho",
  "status.sent": "Em andamento",
  "status.finalizing": "Finalizando",
  "status.awaiting_certificates": "Aguardando certificados",
  "status.completed": "Concluído",
  "status.declined": "Recusado",
  "status.voided": "Cancelado",
  "status.expired": "Expirado",
  "status.all": "Todos",
  "rstatus.created": "Pendente",
  "rstatus.sent": "Enviado",
  "rstatus.viewed": "Visualizado",
  "rstatus.signed": "Assinou",
  "rstatus.declined": "Recusou",
  "rstatus.completed": "Recebeu cópia",
  "rstatus.delegated": "Delegou",
  "rstatus.reassigned": "Reatribuído",
  "list.title": "Envelopes",
  "list.new": "Novo envelope",
  "list.search": "Buscar por assunto…",
  "list.empty": "Ainda não há envelopes.",
  "list.subject": "Assunto",
  "list.recipients": "Destinatários",
  "list.status": "Status",
  "list.created": "Criado",
  "list.loadMore": "Carregar mais",
  "list.newSubject": "Assunto do envelope",
  "list.create": "Criar",
  "edit.title": "Preparar envelope",
  "edit.step.documents": "Documentos",
  "edit.step.recipients": "Destinatários",
  "edit.step.fields": "Campos",
  "edit.step.review": "Revisar e enviar",
  "edit.upload": "Enviar PDF",
  "edit.uploading": "Enviando…",
  "edit.dropHint": "Envie um ou mais PDFs. Eles são assinados na ordem da lista.",
  "edit.pages": "págs.",
  "edit.noDocuments": "Ainda não há documentos.",
  "edit.hadSignatures":
    "{names}: o arquivo tinha assinaturas digitais. Ao enviá-lo, ele é saneado (formulários achatados, conteúdo ativo e anexos removidos) e essas assinaturas se perdem: o documento salvo e o PDF final não as conservam.",
  "edit.formAppearanceMismatch":
    "{names}: o formulário pedia que o leitor redesenhasse os campos e algum não pôde ser redesenhado. Ficou fixado como estava salvo no arquivo, que outro programa poderia mostrar diferente: revise o documento antes de enviá-lo.",
  "edit.addRecipient": "Adicionar destinatário",
  "edit.role": "Função",
  "edit.role.signer": "Signatário",
  "edit.role.cc": "Cópia",
  "edit.role.approver": "Aprovador",
  "edit.order": "Ordem",
  "edit.orderHint": "Mesmo número = assinam em paralelo; diferente = em sequência.",
  "edit.name": "Nome",
  "edit.phone": "Telefone (E.164)",
  "edit.channels": "Canais",
  "edit.locale": "Idioma",
  "edit.idType": "Documento",
  "edit.idNumber": "Número",
  "edit.telegramChatId": "Telegram chat ID",
  "edit.telegramHint": "Opcional: se ficar vazio, o signatário vincula o Telegram a partir do convite.",
  // Edición concurrente, salida con cambios sin guardar y validación de campos en los editores
  "common.unsavedLeave": "Há alterações não salvas. Sair mesmo assim e descartá-las?",
  "edit.versionChanged": "Este rascunho mudou em outra aba ou foi editado por outra pessoa. Recarregue para ver a versão atual.",
  "edit.reload": "Recarregar",
  "edit.reloadConfirm": "Ao recarregar, as alterações não salvas desta aba são descartadas. Continuar?",
  "edit.roleDropsFields": "{name} tem {n} campo(s) no documento. Se deixar de ser signatário, esses campos são excluídos ao salvar. Continuar?",
  "edit.err.field": "{field} (página {page}): {msg}",
  "edit.err.dropdownOptions": "a lista suspensa precisa de pelo menos uma opção.",
  "edit.err.minMax": "o mínimo não pode ser maior que o máximo.",
  "edit.err.readOnlyValue": "um campo somente leitura precisa de um valor preenchido.",
  "edit.err.prefillOption": "o valor preenchido não é uma das opções.",
  "edit.err.formula": "a fórmula não é válida.",
  "edit.err.formulaRef": "a fórmula cita {ref}, que não é a etiqueta de outro campo número.",
  "edit.err.formulaDupLabel": "há dois campos número com a etiqueta {label} e a fórmula a usa.",
  "edit.err.condition": "uma condição cita um campo que não existe ou o próprio campo.",
  "edit.err.conditionValue": "falta o valor a comparar em uma condição.",
  "edit.fieldKeysHint": "Pelo teclado: escolha um tipo de campo e a página e use \"Adicionar à página\" (fica no centro da parte visível); Tab chega a cada campo, Enter o seleciona, as setas o movem, Shift + setas mudam o tamanho e Delete o exclui.",
  "detail.telegramLinked": "Telegram vinculado",
  "detail.telegramPending": "Telegram não vinculado",
  "sign.telegram": "Receber avisos pelo Telegram",
  "edit.noRecipients": "Adicione pelo menos um signatário.",
  "edit.palette": "Arraste ou clique na página para posicionar",
  "edit.activeRecipient": "Campos para",
  "edit.required": "Obrigatório",
  "edit.label": "Rótulo",
  "edit.fieldFor": "Signatário",
  "edit.selectFieldHint": "Escolha um tipo de campo e clique na página.",
  "edit.noSigners": "Primeiro adicione signatários.",
  "edit.subject": "Assunto",
  "edit.message": "Mensagem",
  "edit.expires": "Expira em",
  "edit.send": "Enviar",
  "edit.sending": "Enviando…",
  "edit.summary": "Resumo",
  "edit.fieldsCount": "{n} campo|{n} campos",
  "edit.placePage": "Página onde adicioná-lo",
  "edit.pageN": "Página {page}",
  "edit.addToPage": "Adicionar à página {page}",
  "edit.saved": "Salvo",
  "field.signature": "Assinatura",
  "field.initials": "Rubrica",
  "field.date_signed": "Data da assinatura",
  "field.name": "Nome",
  "field.email": "E-mail",
  "field.text": "Texto",
  "field.checkbox": "Caixa de seleção",
  "detail.recipients": "Destinatários",
  "detail.timeline": "Trilha de auditoria",
  "detail.download": "Baixar PDF assinado",
  "detail.void": "Cancelar envelope",
  "detail.voidReason": "Motivo do cancelamento",
  "detail.remind": "Reenviar aviso",
  "detail.reminded": "Avisos reenviados",
  "detail.edit": "Editar rascunho",
  "detail.documents": "Documentos",
  "detail.hash": "Hash",
  "detail.sent": "Enviado",
  "detail.viewed": "Visualizado",
  "detail.signed": "Assinado",
  "detail.declined": "Recusado",
  "detail.declineReason": "Motivo",
  "detail.voidedReason": "Cancelado:",
  "detail.sha": "SHA-256 do PDF final",
  "detail.finalizeFailed": "Não foi possível concluir a selagem do documento. Você pode tentar novamente; se falhar de novo, contate o suporte.",
  "detail.finalizeFailedUnsealable":
    "O documento não pode ser selado (código {code}). Tentar novamente não resolve: anule o envelope e envie-o de novo (com o PDF exportado novamente ou impresso como PDF).",
  "detail.retryFinalize": "Tentar finalizar novamente",
  "detail.finalizeRetried": "Nova tentativa em andamento",
  "keys.title": "API keys",
  "keys.intro": "Use uma API key para integrar o CalaSign ao seu sistema: Authorization: Bearer <key>.",
  "keys.name": "Nome",
  "keys.create": "Criar API key",
  "keys.secretOnce": "Copie a chave agora: ela não será exibida novamente.",
  "keys.revoke": "Revogar",
  "keys.revoked": "Revogada",
  "keys.lastUsed": "Último uso",
  "keys.empty": "Não há API keys.",
  "sign.consentTitle": "Antes de começar",
  "sign.consentText":
    "Concordo em assinar eletronicamente e receber os documentos por meios eletrônicos. Entendo que minha assinatura eletrônica tem a mesma validade que minha assinatura manuscrita e que a data, a hora, meu endereço IP e meu dispositivo serão registrados como evidência.",
  "sign.consentAccept": "Concordo e continuo",
  "sign.sentBy": "enviou para você assinar",
  "sign.progress": "{done} de {total} campos",
  "sign.nextField": "Próximo campo",
  "sign.finish": "Concluir",
  "sign.finishing": "Assinando…",
  "sign.decline": "Recusar",
  "sign.declineTitle": "Recusar o documento",
  "sign.declineReason": "Conte ao remetente o motivo",
  "sign.declineConfirm": "Recusar",
  "sign.adoptTitle": "Adote sua assinatura",
  "sign.adoptInitials": "Adote sua rubrica",
  "sign.draw": "Desenhar",
  "sign.type": "Digitar",
  "sign.clear": "Limpar",
  "sign.adopt": "Adotar e assinar",
  "sign.drawHere": "Desenhe sua assinatura aqui",
  "sign.typeHere": "Digite seu nome",
  "sign.clickToSign": "Assinar",
  "sign.missing": "Preencha os campos obrigatórios",
  "sign.doneTitle": "Pronto! Você assinou o documento",
  "sign.doneText": "Quando todos assinarem, você receberá uma cópia do documento final.",
  "sign.doneTextDownload": "Guarde o link desta página: quando todos assinarem, você poderá baixar o documento final aqui (não o enviamos por e-mail porque você não validou seu endereço).",
  "sign.doneAvailable": "O documento está concluído e selado.",
  "sign.downloadSigned": "Baixar documento assinado",
  "sign.downloadCopy": "Baixar cópia com sua assinatura",
  "sign.copyNote": "É uma cópia do que foi assinado até agora. O documento final selado ficará disponível aqui quando todos terminarem.",
  "sign.sealing": "Todos assinaram. Estamos selando o documento final: em alguns segundos você poderá baixá-lo aqui.",
  "sign.declinedTitle": "Você recusou o documento",
  "sign.declinedText": "Avisamos o remetente.",
  "sign.notYourTurnTitle": "Ainda não é a sua vez",
  "sign.notYourTurnText": "Vamos avisar você quando os signatários anteriores terminarem.",
  "sign.voidedTitle": "Este envelope foi cancelado",
  "sign.expiredTitle": "Este envelope expirou",
  "sign.closedText": "Não é mais possível assinar. Fale com o remetente se tiver dúvidas.",
  "sign.declinedByOtherTitle": "Este envelope foi recusado",
  "sign.ccTitle": "Você recebeu uma cópia",
  "sign.ccText": "Você não precisa assinar nada. Pode revisar os documentos.",
  "sign.invalidTitle": "Link inválido ou expirado",
  "sign.invalidText": "Peça ao remetente para reenviar o envelope.",
  "sign.autoField": "preenchido ao assinar",
  "sign.poweredBy": "Assinatura eletrônica segura com CalaSign",
  "mailbox.title": "Caixa de desenvolvimento",
  "mailbox.intro": "Mensagens que o servidor teria enviado por e-mail ou WhatsApp.",
  "mailbox.empty": "Não há mensagens.",
  "mailbox.open": "Abrir link",
};

const en: Dict = {
  "app.name": "CalaSign",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.back": "Back",
  "common.next": "Next",
  "common.loading": "Loading…",
  "common.close": "Close",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.refresh": "Refresh",
  "common.optional": "optional",
  "common.error": "Something went wrong",
  "common.language": "Language",
  "common.none": "—",
  "common.confirmAction": "Are you sure? This action cannot be undone.",
  "common.needsViewAll": "Read-only: changing these settings also requires the permission to view all of the organization's envelopes.",
  "common.notInPlan": "Not included in your plan ({plan}): you can view, pause or remove what is already configured, but not create or enable anything new.",
  "common.seePlans": "See plans",
  "common.askAdminPlan": "Ask an administrator of your organization to review the plan.",
  "common.notInPlanShort": "Not included in your plan",
  "nav.envelopes": "Envelopes",
  "nav.apiKeys": "API keys",
  "nav.mailbox": "Dev mailbox",
  "nav.logout": "Log out",
  "nav.menu": "Menu",
  "auth.login": "Log in",
  "auth.signup": "Create account",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.passwordHint": "At least 10 characters",
  "auth.name": "Your name",
  "auth.organization": "Organization",
  "auth.noAccount": "No account yet?",
  "auth.haveAccount": "Already have an account?",
  "auth.tagline": "Cloud e-signature for Latin America",
  "status.draft": "Draft",
  "status.sent": "In progress",
  "status.finalizing": "Finalizing",
  "status.awaiting_certificates": "Awaiting certificates",
  "status.completed": "Completed",
  "status.declined": "Declined",
  "status.voided": "Voided",
  "status.expired": "Expired",
  "status.all": "All",
  "rstatus.created": "Pending",
  "rstatus.sent": "Sent",
  "rstatus.viewed": "Viewed",
  "rstatus.signed": "Signed",
  "rstatus.declined": "Declined",
  "rstatus.completed": "Got copy",
  "rstatus.delegated": "Delegated",
  "rstatus.reassigned": "Reassigned",
  "list.title": "Envelopes",
  "list.new": "New envelope",
  "list.search": "Search by subject…",
  "list.empty": "No envelopes yet.",
  "list.subject": "Subject",
  "list.recipients": "Recipients",
  "list.status": "Status",
  "list.created": "Created",
  "list.loadMore": "Load more",
  "list.newSubject": "Envelope subject",
  "list.create": "Create",
  "edit.title": "Prepare envelope",
  "edit.step.documents": "Documents",
  "edit.step.recipients": "Recipients",
  "edit.step.fields": "Fields",
  "edit.step.review": "Review & send",
  "edit.upload": "Upload PDF",
  "edit.uploading": "Uploading…",
  "edit.dropHint": "Upload one or more PDFs. They are signed in list order.",
  "edit.pages": "pages",
  "edit.noDocuments": "No documents yet.",
  "edit.hadSignatures":
    "{names}: the file had digital signatures. Uploaded PDFs are sanitized (forms flattened, active content and attachments removed) and those signatures are lost: the stored document and the final PDF don't keep them.",
  "edit.formAppearanceMismatch":
    "{names}: the form asked the reader to redraw its fields and some couldn't be redrawn. They were fixed as saved in the file, which another program might show differently: review the document before sending it.",
  "edit.addRecipient": "Add recipient",
  "edit.role": "Role",
  "edit.role.signer": "Signer",
  "edit.role.cc": "CC",
  "edit.role.approver": "Approver",
  "edit.order": "Order",
  "edit.orderHint": "Same number = sign in parallel; different = in sequence.",
  "edit.name": "Name",
  "edit.phone": "Phone (E.164)",
  "edit.channels": "Channels",
  "edit.locale": "Language",
  "edit.idType": "ID document",
  "edit.idNumber": "Number",
  "edit.telegramChatId": "Telegram chat ID",
  "edit.telegramHint": "Optional: if empty, the signer links Telegram from the invitation.",
  // Edición concurrente, salida con cambios sin guardar y validación de campos en los editores
  "common.unsavedLeave": "You have unsaved changes. Leave anyway and discard them?",
  "edit.versionChanged": "This draft was changed in another tab or by someone else. Reload to see the current version.",
  "edit.reload": "Reload",
  "edit.reloadConfirm": "Reloading discards the unsaved changes in this tab. Continue?",
  "edit.roleDropsFields": "{name} has {n} field(s) on the document. If they stop being a signer, those fields are deleted on save. Continue?",
  "edit.err.field": "{field} (page {page}): {msg}",
  "edit.err.dropdownOptions": "the dropdown needs at least one option.",
  "edit.err.minMax": "the minimum can't be greater than the maximum.",
  "edit.err.readOnlyValue": "a read-only field needs a prefilled value.",
  "edit.err.prefillOption": "the prefilled value isn't one of the options.",
  "edit.err.formula": "the formula isn't valid.",
  "edit.err.formulaRef": "the formula references {ref}, which isn't the label of another number field.",
  "edit.err.formulaDupLabel": "there are two number fields labeled {label} and the formula uses it.",
  "edit.err.condition": "a condition references a field that doesn't exist or the field itself.",
  "edit.err.conditionValue": "a condition is missing the value to compare.",
  "edit.fieldKeysHint": "With the keyboard: pick a field type and the page and press \"Add to page\" (it lands in the center of the visible part); Tab reaches each field, Enter selects it, arrow keys move it, Shift + arrows resize it and Delete removes it.",
  "detail.telegramLinked": "Telegram linked",
  "detail.telegramPending": "Telegram not linked",
  "sign.telegram": "Get notifications on Telegram",
  "edit.noRecipients": "Add at least one signer.",
  "edit.palette": "Drag or click on the page to place",
  "edit.activeRecipient": "Fields for",
  "edit.required": "Required",
  "edit.label": "Label",
  "edit.fieldFor": "Signer",
  "edit.selectFieldHint": "Pick a field type and click on the page.",
  "edit.noSigners": "Add signers first.",
  "edit.subject": "Subject",
  "edit.message": "Message",
  "edit.expires": "Expires on",
  "edit.send": "Send",
  "edit.sending": "Sending…",
  "edit.summary": "Summary",
  "edit.fieldsCount": "{n} field|{n} fields",
  "edit.placePage": "Page to add it to",
  "edit.pageN": "Page {page}",
  "edit.addToPage": "Add to page {page}",
  "edit.saved": "Saved",
  "field.signature": "Signature",
  "field.initials": "Initials",
  "field.date_signed": "Date signed",
  "field.name": "Name",
  "field.email": "Email",
  "field.text": "Text",
  "field.checkbox": "Checkbox",
  "detail.recipients": "Recipients",
  "detail.timeline": "Audit trail",
  "detail.download": "Download signed PDF",
  "detail.void": "Void",
  "detail.voidReason": "Reason for voiding",
  "detail.remind": "Resend notice",
  "detail.reminded": "Notices resent",
  "detail.edit": "Edit draft",
  "detail.documents": "Documents",
  "detail.hash": "Hash",
  "detail.sent": "Sent",
  "detail.viewed": "Viewed",
  "detail.signed": "Signed",
  "detail.declined": "Declined",
  "detail.declineReason": "Reason",
  "detail.voidedReason": "Voided:",
  "detail.sha": "SHA-256 of final PDF",
  "detail.finalizeFailed": "The document could not be sealed. You can retry; if it fails again, contact support.",
  "detail.finalizeFailedUnsealable":
    "The document can't be sealed (code {code}). Retrying won't fix it: void the envelope and send it again (with the PDF exported again or printed to PDF).",
  "detail.retryFinalize": "Retry finalization",
  "detail.finalizeRetried": "Retry in progress",
  "keys.title": "API keys",
  "keys.intro": "Use an API key to integrate CalaSign: Authorization: Bearer <key>.",
  "keys.name": "Name",
  "keys.create": "Create API key",
  "keys.secretOnce": "Copy the key now: it won't be shown again.",
  "keys.revoke": "Revoke",
  "keys.revoked": "Revoked",
  "keys.lastUsed": "Last used",
  "keys.empty": "No API keys.",
  "sign.consentTitle": "Before you start",
  "sign.consentText":
    "I agree to sign electronically and to receive documents electronically. I understand my electronic signature is as valid as my handwritten signature, and that the date, time, my IP address and my device will be recorded as evidence.",
  "sign.consentAccept": "I agree, continue",
  "sign.sentBy": "sent you a document to sign",
  "sign.progress": "{done} of {total} fields",
  "sign.nextField": "Next field",
  "sign.finish": "Finish",
  "sign.finishing": "Signing…",
  "sign.decline": "Decline",
  "sign.declineTitle": "Decline the document",
  "sign.declineReason": "Tell the sender why",
  "sign.declineConfirm": "Decline",
  "sign.adoptTitle": "Adopt your signature",
  "sign.adoptInitials": "Adopt your initials",
  "sign.draw": "Draw",
  "sign.type": "Type",
  "sign.clear": "Clear",
  "sign.adopt": "Adopt and sign",
  "sign.drawHere": "Draw your signature here",
  "sign.typeHere": "Type your name",
  "sign.clickToSign": "Sign",
  "sign.missing": "Complete the required fields",
  "sign.doneTitle": "Done! You signed the document",
  "sign.doneText": "You'll get a copy of the final document once everyone signs.",
  "sign.doneTextDownload": "Save this page's link: once everyone signs you can download the final document here (we don't email it because you didn't verify your address).",
  "sign.doneAvailable": "The document is complete and sealed.",
  "sign.downloadSigned": "Download signed document",
  "sign.downloadCopy": "Download a copy with your signature",
  "sign.copyNote": "This is a copy of what has been signed so far. The final sealed document will be available here once everyone finishes.",
  "sign.sealing": "Everyone has signed. We are sealing the final document: you will be able to download it here in a few seconds.",
  "sign.declinedTitle": "You declined the document",
  "sign.declinedText": "We let the sender know.",
  "sign.notYourTurnTitle": "It's not your turn yet",
  "sign.notYourTurnText": "We'll notify you when the previous signers are done.",
  "sign.voidedTitle": "This envelope was voided",
  "sign.expiredTitle": "This envelope expired",
  "sign.closedText": "It can no longer be signed. Contact the sender if you have questions.",
  "sign.declinedByOtherTitle": "This envelope was declined",
  "sign.ccTitle": "You received a copy",
  "sign.ccText": "You don't need to sign anything. You can review the documents.",
  "sign.invalidTitle": "Invalid or expired link",
  "sign.invalidText": "Ask the sender to resend the envelope.",
  "sign.autoField": "filled in on signing",
  "sign.poweredBy": "Secure e-signature by CalaSign",
  "mailbox.title": "Dev mailbox",
  "mailbox.intro": "Messages the server would have sent by email or WhatsApp.",
  "mailbox.empty": "No messages.",
  "mailbox.open": "Open link",
};

const DICTS: Record<Locale, Record<MessageKey, string>> = {
  es: { ...es, ...prodEs },
  "pt-BR": { ...ptBR, ...prodPt },
  en: { ...en, ...prodEn },
};

export const LOCALE_LABELS: Record<Locale, string> = { es: "Español", "pt-BR": "Português", en: "English" };

const STORAGE_KEY = "calasign.locale";

function readStored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && Object.prototype.hasOwnProperty.call(DICTS, v) ? (v as Locale) : null;
  } catch {
    return null;
  }
}

function detect(): Locale {
  const stored = readStored();
  if (stored) return stored;
  const nav = (typeof navigator !== "undefined" ? navigator.language : "es").toLowerCase();
  if (nav.startsWith("pt")) return "pt-BR";
  if (nav.startsWith("en")) return "en";
  return "es";
}

export type TFunc = (key: MessageKey, vars?: Record<string, string | number>) => string;
/** Texto con plural: el diccionario trae "singular|plural" y se elige con Intl.PluralRules; {n} va con el formato del idioma. */
export type TNFunc = (key: MessageKey, n: number, vars?: Record<string, string | number>) => string;

/**
 * Elige la forma de un texto "uno|otros" CRUDO (antes de interpolar) según Intl.PluralRules del idioma; en es/pt el 0
 * va en plural. Un texto sin "|" se devuelve tal cual. Implementación en lib/interpolate.ts.
 */
export { pluralize, interpolate, formatText } from "./interpolate";

/** Número con el formato del idioma de la app (separador de miles y decimales). */
export function formatNumber(n: number, locale: Locale = activeLocale, opts?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(locale, opts).format(n);
  } catch {
    return String(n);
  }
}

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  t: TFunc;
  tn: TNFunc;
  /** true si el usuario eligió idioma explícitamente (no se pisa con el del destinatario). */
  explicit: boolean;
}

const Ctx = createContext<I18nCtx | null>(null);

// Idioma activo para código fuera de React (p. ej. errorText en lib/api.ts, que traduce errores por código).
let activeLocale: Locale = "es";
export function currentLocale(): Locale {
  return activeLocale;
}

/** Nombre del tipo de campo ("field.signature" → "Firma") en el idioma activo, para código fuera de React. */
export function fieldTypeLabel(type: string, locale: Locale = activeLocale): string {
  const key = `field.${type}` as MessageKey;
  return DICTS[locale][key] ?? DICTS.es[key] ?? type;
}

/** Confirmación para acciones destructivas que no tienen modal propio (revocar, rotar, borrar). */
export function confirmAction(): boolean {
  return typeof window === "undefined" || window.confirm(DICTS[activeLocale]["common.confirmAction"]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detect);
  activeLocale = locale;
  const [explicit, setExplicit] = useState<boolean>(() => readStored() !== null);

  const setLocale = useCallback((l: Locale, persist = true) => {
    setLocaleState(l);
    if (persist) {
      setExplicit(true);
      try {
        localStorage.setItem(STORAGE_KEY, l);
      } catch {
        /* sin almacenamiento */
      }
    }
  }, []);
  // <html lang> sigue al idioma activo, también el inicial (guardado o del navegador): index.html trae "es" fijo y,
  // si solo se cambiaba en setLocale, un lector de pantalla leía la interfaz en inglés con pronunciación española.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Marca blanca: textos propios de la marca y nombre del producto (lib/white-label.ts). Cambia con la marca activa.
  const brandV = useBrandVersion();
  const t = useCallback<TFunc>(
    (key, vars) => {
      return interpolate(brandText(locale, key, DICTS[locale][key] ?? DICTS.es[key] ?? key), vars);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, brandV],
  );

  // Plural primero (sobre el texto crudo) y variables después: así {n} se reemplaza en todas sus apariciones y un
  // valor con "|" no altera la elección de forma.
  const tn = useCallback<TNFunc>(
    (key, n, vars) =>
      interpolate(pluralize(locale, brandText(locale, key, DICTS[locale][key] ?? DICTS.es[key] ?? key), n), { ...vars, n: formatNumber(n, locale) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, brandV],
  );

  const value = useMemo(() => ({ locale, setLocale, t, tn, explicit }), [locale, setLocale, t, tn, explicit]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("I18nProvider faltante");
  return c;
}

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Fecha sin hora (YYYY-MM-DD: vencimiento, vigencia…). Se arma en UTC y se muestra en UTC: con el mediodía UTC en la
 * zona local, en UTC+13/+14 (Tonga, Kiribati, Nueva Zelanda en verano) se veía el día siguiente.
 */
export function formatDay(ymd: string | null | undefined, locale: Locale): string {
  if (!ymd) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  } catch {
    return ymd;
  }
}

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Fecha local (YYYY-MM-DD) para un <input type="date">: con el ISO en UTC, en América la fecha corría un día. */
export function localDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Vencimiento a guardar desde un <input type="date">: el fin de ese día local (23:59:59). Con la fecha sin tocar se
 * conserva el guardado (uno puesto por la API a otra hora se corría a las 23:59 en cada guardado); con `mustBeFuture`,
 * solo si todavía no pasó: un borrador con vencimiento de hoy a las 10:00 enviado a las 15:00 fallaba con "la fecha
 * de vencimiento ya pasó", aunque la pantalla mostraba la fecha de hoy.
 */
export function expiryFromDateInput(input: string, stored: string | null | undefined, opts: { mustBeFuture?: boolean } = {}): string | null {
  if (!input) return null;
  if (stored && localDateInput(stored) === input && (!opts.mustBeFuture || new Date(stored).getTime() > Date.now())) return stored;
  return new Date(`${input}T23:59:59`).toISOString();
}

/** Ejemplos de los placeholders (nombres de integraciones y sellos) en el idioma de la interfaz. */
const PLACEHOLDERS = {
  integration: { es: "ERP producción", "pt-BR": "ERP produção", en: "Production ERP" },
  seal: { es: "Sello ACME S.A.S.", "pt-BR": "Selo ACME Ltda.", en: "ACME Inc. seal" },
  domain: { es: "tuempresa.com", "pt-BR": "suaempresa.com", en: "yourcompany.com" },
  document: { es: "documento", "pt-BR": "documento", en: "document" },
  docTitle: { es: "Contrato con {{cliente.nombre}}", "pt-BR": "Contrato com {{cliente.nome}}", en: "Agreement with {{client.name}}" },
  effectiveVar: { es: "inicio", "pt-BR": "inicio", en: "start" },
  expiryVar: { es: "vencimiento", "pt-BR": "vencimento", en: "expiry" },
  collectTarget: { es: "cliente", "pt-BR": "cliente", en: "client" },
  chatChannel: { es: "firmas", "pt-BR": "assinaturas", en: "signatures" },
  chatTeam: { es: "Legales", "pt-BR": "Jurídico", en: "Legal" },
} as const;
export function placeholderText(key: keyof typeof PLACEHOLDERS): string {
  const loc = currentLocale();
  return PLACEHOLDERS[key][loc as "es" | "pt-BR" | "en"] ?? PLACEHOLDERS[key].es;
}

// Editores con cambios sin guardar montados ahora (lo usan los botones que navegan por código: organización, salir).
let unsavedEditors = 0;
// Salida ya confirmada (p. ej. cerrar sesión tras confirmDiscardUnsaved): la recarga no vuelve a preguntar.
let unloadConfirmed = false;

/** La persona ya confirmó salir: la próxima recarga/navegación completa no muestra el aviso del navegador. */
export function confirmUnload(): void {
  unloadConfirmed = true;
}

/** true si hay algún editor montado con cambios sin guardar (p. ej. para no mandar al login si vence la sesión). */
export function hasUnsavedChanges(): boolean {
  return unsavedEditors > 0;
}

/** true si no hay cambios sin guardar o si la persona confirma descartarlos. */
export function confirmDiscardUnsaved(): boolean {
  return unsavedEditors === 0 || typeof window === "undefined" || window.confirm(DICTS[activeLocale]["common.unsavedLeave"]);
}

/**
 * Aviso al salir con cambios sin guardar (los editores solo guardan con "Guardar" o al cambiar de paso: antes se
 * perdían sin aviso). El navegador avisa al cerrar o recargar la pestaña; dentro de la app (BrowserRouter no tiene
 * bloqueo de navegación) se intercepta el clic en los enlaces internos (Link/NavLink del menú, "← Sobres"…) antes de
 * que React Router navegue, y se pide confirmación.
 */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    unsavedEditors++;
    const h = (e: BeforeUnloadEvent) => {
      if (unloadConfirmed) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // En captura sobre document: corre antes del onClick de React (que escucha en la raíz de la app).
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      // Externos (abren otra página: los cubre beforeunload) o el mismo lugar (anclas #): no se pregunta.
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (window.confirm(DICTS[activeLocale]["common.unsavedLeave"])) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("beforeunload", h);
    document.addEventListener("click", onClick, true);
    return () => {
      unsavedEditors--;
      window.removeEventListener("beforeunload", h);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
}
