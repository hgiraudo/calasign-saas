// Textos en pt-BR y en de códigos de error de la API que la consola, el firmante y las páginas públicas pueden recibir
// (en español se muestra el mensaje de la API, que puede traer detalle). Se suman a CODE_TEXT (lib/api.ts).
// scripts/check-error-codes.mjs (y su test en apps/api/test/error-codes-i18n.test.ts) avisa de los que faltan.
export const MORE_CODE_TEXT: Record<string, { "pt-BR": string; en: string }> = {
  // ── Cuenta, sesión y verificación en dos pasos ──
  "2fa_already_enabled": { "pt-BR": "A verificação em duas etapas já está ativa.", en: "Two-step verification is already enabled." },
  "2fa_required_by_tenant": {
    "pt-BR": "Uma das suas organizações exige verificação em duas etapas.",
    en: "One of your organizations requires two-step verification.",
  },
  "2fa_setup_required": { "pt-BR": "Primeiro gere o código QR.", en: "Generate the QR code first." },
  unauthorized: { "pt-BR": "É preciso entrar novamente.", en: "You need to sign in again." },
  invalid_token: {
    "pt-BR": "O link para redefinir a senha não é válido ou já expirou.",
    en: "The password reset link isn't valid or has expired.",
  },
  password_not_allowed: {
    "pt-BR": "Nesta organização, entre com login único (SSO) ou redefina sua senha.",
    en: "In this organization, sign in with single sign-on (SSO) or reset your password.",
  },
  password_reset_required: {
    "pt-BR": 'Para entrar com senha, redefina-a em "Esqueci minha senha".',
    en: 'To sign in with a password, reset it from "Forgot password".',
  },
  session_required: { "pt-BR": "Esta operação exige entrar pela web.", en: "This operation requires signing in on the web." },
  insufficient_scope: {
    "pt-BR": "O token não tem permissão (scope) para esta operação.",
    en: "The token doesn't have the scope for this operation.",
  },
  use_platform_host: {
    "pt-BR": "Não é possível entrar a partir de um domínio próprio: use o endereço principal do serviço.",
    en: "You can't sign in from a custom domain: use the service's main address.",
  },
  wrong_cell: { "pt-BR": "Os dados desta organização estão em outra região.", en: "This organization's data is in another region." },
  cell_unavailable: { "pt-BR": "Região desconhecida: escolha uma das que aparecem na lista.", en: "Unknown region: pick one from the list." },
  bad_origin: { "pt-BR": "Origem não permitida.", en: "Origin not allowed." },
  shutting_down: {
    "pt-BR": "O servidor está reiniciando: tente novamente em alguns segundos.",
    en: "The server is restarting: try again in a few seconds.",
  },
  conflict: {
    "pt-BR": "O recurso já existe ou mudou ao mesmo tempo: tente novamente.",
    en: "The resource already exists or changed at the same time: try again.",
  },
  invalid_id: { "pt-BR": "Identificador inválido.", en: "Invalid identifier." },
  invalid_text: { "pt-BR": "O texto contém caracteres não permitidos.", en: "The text contains characters that aren't allowed." },
  invalid_cursor: { "pt-BR": "A paginação expirou: recarregue a lista.", en: "The pagination expired: reload the list." },
  invalid_query: { "pt-BR": "Há filtros inválidos na consulta.", en: "The query has invalid filters." },
  invalid_range: { "pt-BR": "O intervalo de datas é inválido (máximo de 3 anos).", en: "The date range is invalid (at most 3 years)." },
  invalid_request: { "pt-BR": "Faltam dados no pedido.", en: "The request is missing data." },
  invalid_json: { "pt-BR": "Os dados enviados não são JSON válido.", en: "The data sent isn't valid JSON." },
  invalid_meta: { "pt-BR": "O campo 'meta' não é JSON válido.", en: "The 'meta' field isn't valid JSON." },
  invalid_version: { "pt-BR": "Versão inválida.", en: "Invalid version." },
  invalid_url: {
    "pt-BR": "URL inválida (deve ser https e não pode ser um endereço local).",
    en: "Invalid URL (it must be https and not a local address).",
  },
  invalid_origin: { "pt-BR": "Só são aceitas origens https.", en: "Only https origins are allowed." },
  invalid_event: { "pt-BR": "Evento desconhecido.", en: "Unknown event." },
  no_changes: { "pt-BR": "Não há alterações para aplicar.", en: "There are no changes to apply." },

  // ── Equipo, roles, invitaciones ──
  invalid_role: { "pt-BR": "Função inválida.", en: "Invalid role." },
  invalid_group: { "pt-BR": "Algum grupo não existe.", en: "Some group doesn't exist." },
  invitation_accepted: { "pt-BR": "Este convite já foi aceito.", en: "This invitation has already been accepted." },
  invitation_revoked: { "pt-BR": "Este convite foi revogado.", en: "This invitation was revoked." },
  invitation_expired: { "pt-BR": "Este convite expirou: peça um novo.", en: "This invitation has expired: ask for a new one." },

  // ── SSO ──
  sso_disabled: { "pt-BR": "Para exigir SSO, primeiro é preciso habilitá-lo.", en: "To require SSO, enable it first." },
  oidc_config_required: {
    "pt-BR": "Falta a configuração OIDC (issuer e client id).",
    en: "The OIDC configuration (issuer and client ID) is missing.",
  },
  invalid_issuer: { "pt-BR": "O issuer deve ser https.", en: "The issuer must be https." },
  invalid_entry_point: { "pt-BR": "A URL de login do IdP deve ser https.", en: "The IdP sign-in URL must be https." },
  sso_assertion_replay: { "pt-BR": "Esta resposta SAML já foi usada: entre novamente.", en: "This SAML response was already used: sign in again." },
  sso_domain_mismatch: {
    "pt-BR": "O e-mail não pertence aos domínios da organização.",
    en: "The email doesn't belong to the organization's domains.",
  },
  sso_domain_not_verified: {
    "pt-BR": "Para criar usuários por SSO, o domínio do e-mail precisa estar verificado na organização.",
    en: "To create users through SSO, the email domain must be verified in the organization.",
  },
  sso_email_unverified: {
    "pt-BR": "O e-mail não está verificado no provedor de identidade.",
    en: "The email isn't verified at the identity provider.",
  },
  sso_invalid_response: { "pt-BR": "A resposta do provedor de identidade é inválida.", en: "The identity provider's response is invalid." },
  sso_member_removed: {
    "pt-BR": "Um administrador removeu você desta organização. Para voltar, peça que convide você novamente.",
    en: "An administrator removed you from this organization. To get back in, ask them to invite you again.",
  },
  sso_no_email: { "pt-BR": "O provedor de identidade não enviou um e-mail válido.", en: "The identity provider didn't send a valid email." },
  sso_not_member: {
    "pt-BR": "Você não é membro desta organização. Peça um convite ao administrador.",
    en: "You're not a member of this organization. Ask the administrator for an invitation.",
  },
  sso_plan_limit: {
    "pt-BR": "O plano da organização atingiu o limite de usuários: peça ao administrador que o amplie.",
    en: "The organization's plan has reached its user limit: ask the administrator to upgrade it.",
  },
  sso_scim_deactivated: {
    "pt-BR": "Seu provedor de identidade desativou você nesta organização. Peça a um administrador que convide você.",
    en: "Your identity provider deactivated you in this organization. Ask an administrator to invite you.",
  },

  // ── OAuth y aplicaciones ──
  revoked: { "pt-BR": "O aplicativo está revogado.", en: "The application is revoked." },
  public_client: { "pt-BR": "Um cliente público não tem segredo.", en: "A public client has no secret." },

  // ── Marca, dominios, almacenamiento, integraciones ──
  brand_exists: { "pt-BR": "Já existe uma marca com esse nome.", en: "A brand with that name already exists." },
  default_brand: { "pt-BR": "A marca da organização não pode ser excluída.", en: "The organization's brand can't be deleted." },
  invalid_brand: { "pt-BR": "A marca não existe nesta organização.", en: "The brand doesn't exist in this organization." },
  invalid_asset: {
    "pt-BR": "O arquivo não é válido (SVG com scripts ou referências externas, ou PNG danificado ou maior que 4096×4096).",
    en: "The file isn't valid (SVG with scripts or external references, or a damaged PNG or one larger than 4096×4096).",
  },
  invalid_logo: {
    "pt-BR": "O logotipo deve ser PNG, JPG ou SVG (sem scripts nem referências externas).",
    en: "The logo must be PNG, JPG or SVG (with no scripts or external references).",
  },
  invalid_css: { "pt-BR": "O CSS próprio tem algo não permitido.", en: "The custom CSS contains something that isn't allowed." },
  use_custom_domain: {
    "pt-BR": "A marca da organização usa Configurações → Domínio próprio.",
    en: "The organization's brand uses Settings → Custom domain.",
  },
  domain_taken: {
    "pt-BR": "Esse domínio já está registrado por outra organização.",
    en: "That domain is already registered by another organization.",
  },
  reserved_domain: { "pt-BR": "Esse domínio não pode ser usado.", en: "That domain can't be used." },
  email_domain_required: {
    "pt-BR": "Adicione e verifique o domínio de e-mail antes de usá-lo como remetente.",
    en: "Add and verify the email domain before using it as the sender.",
  },
  frame_ancestor_not_allowed: {
    "pt-BR": "A origem não está autorizada na configuração da organização.",
    en: "The origin isn't authorized in the organization's settings.",
  },
  too_many_connections: {
    "pt-BR": "Você atingiu o máximo de conexões de armazenamento da organização.",
    en: "You've reached the organization's maximum number of storage connections.",
  },
  storage_reconnect_required: {
    "pt-BR": "Quem conectou esta conta não faz mais parte da organização: conecte o armazenamento novamente.",
    en: "The person who connected this account is no longer part of the organization: connect the storage again.",
  },
  too_many_integrations: {
    "pt-BR": "Máximo de 20 integrações de avisos por organização.",
    en: "At most 20 notification integrations per organization.",
  },
  site_required: { "pt-BR": "Informe a URL do site do SharePoint.", en: "Enter the SharePoint site URL." },
  storage_test_failed: {
    "pt-BR": "Não foi possível gravar no bucket: revise as credenciais e permissões.",
    en: "Couldn't write to the bucket: check the credentials and permissions.",
  },
  storage_unavailable: {
    "pt-BR": "O armazenamento de documentos não está disponível agora. Tente novamente em alguns minutos.",
    en: "Document storage isn't available right now. Try again in a few minutes.",
  },
  already_exported: { "pt-BR": "Já foi exportado.", en: "It was already exported." },
  export_in_progress: { "pt-BR": "A exportação já está em andamento.", en: "The export is already in progress." },
  otp_template_missing_code: {
    "pt-BR": "O modelo do código de verificação precisa incluir {{code}}.",
    en: "The verification code template must include {{code}}.",
  },
  byok_key_unavailable: {
    "pt-BR":
      "A chave de criptografia da sua organização (BYOK) não está disponível: não é possível salvar nem ler documentos até restabelecer o acesso.",
    en: "Your organization's encryption key (BYOK) isn't available: documents can't be saved or read until access is restored.",
  },
  byok_not_configured: { "pt-BR": "Não há uma chave configurada.", en: "No key is configured." },

  // ── CRM ──
  crm_connection_inactive: { "pt-BR": "A conexão está desativada.", en: "The connection is deactivated." },
  crm_invalid_record: {
    "pt-BR": "O registro tem dados que não servem para o envelope.",
    en: "The record has data that can't be used for the envelope.",
  },
  crm_link_exists: {
    "pt-BR": "O envelope já está vinculado a um registro desta conexão.",
    en: "The envelope is already linked to a record from this connection.",
  },
  crm_mapping_inactive: { "pt-BR": "O mapeamento está desativado.", en: "The mapping is deactivated." },
  crm_mapping_owner_gone: {
    "pt-BR": "Quem criou o mapeamento não tem mais acesso: crie-o novamente.",
    en: "The mapping's creator no longer has access: create it again.",
  },
  crm_object_type: { "pt-BR": "Esse tipo de registro não é suportado por este CRM.", en: "That record type isn't supported by this CRM." },
  crm_provider_error: { "pt-BR": "O CRM respondeu com um erro: tente mais tarde.", en: "The CRM returned an error: try again later." },
  crm_reauth_required: { "pt-BR": "A conexão perdeu o acesso: conecte-a de novo.", en: "The connection lost access: connect it again." },
  crm_record_not_found: { "pt-BR": "O registro não existe no CRM.", en: "The record doesn't exist in the CRM." },
  crm_template_required: { "pt-BR": "O mapeamento precisa de um modelo.", en: "The mapping needs a template." },
  crm_test_failed: { "pt-BR": "Não foi possível conectar: revise as credenciais.", en: "Couldn't connect: check the credentials." },
  crm_trigger: { "pt-BR": "Esse disparo não é suportado por este CRM ou ERP.", en: "That trigger isn't supported by this CRM or ERP." },
  already_succeeded: { "pt-BR": "Já foi concluído.", en: "It already completed." },

  // ── Facturación y pagos ──
  billing_provider_error: {
    "pt-BR": "O provedor de pagamentos respondeu com um erro: tente mais tarde.",
    en: "The payment provider returned an error: try again later.",
  },
  billing_requires_user: {
    "pt-BR": "A assinatura só pode ser alterada pelo console, com uma sessão de usuário.",
    en: "The subscription can only be changed from the console, with a user session.",
  },
  email_required: {
    "pt-BR": "O Mercado Pago precisa do e-mail de um usuário para a assinatura.",
    en: "Mercado Pago needs a user's email for the subscription.",
  },
  invalid_plan: { "pt-BR": "Esse plano não tem preço nessa moeda.", en: "That plan has no price in that currency." },
  portal_not_available: {
    "pt-BR": "O portal de faturamento está disponível para assinaturas do Stripe.",
    en: "The billing portal is available for Stripe subscriptions.",
  },
  provider_currency_unsupported: {
    "pt-BR": "O provedor não cobra assinaturas nessa moeda.",
    en: "The provider doesn't charge subscriptions in that currency.",
  },
  provider_not_configured: { "pt-BR": "O provedor não está configurado neste ambiente.", en: "The provider isn't configured in this environment." },
  already_paid: { "pt-BR": "O pagamento já está confirmado.", en: "The payment is already confirmed." },
  invalid_payer: { "pt-BR": "O pagador deve ser um signatário do envelope.", en: "The payer must be a signer of the envelope." },
  payment_mismatch: {
    "pt-BR": "O valor ou a moeda do pagamento não coincidem com a cobrança.",
    en: "The payment amount or currency doesn't match the charge.",
  },
  payment_not_available: { "pt-BR": "O envelope não aceita pagamentos agora.", en: "The envelope doesn't accept payments right now." },
  payment_processing: {
    "pt-BR": "O pagamento está sendo processado; em instantes ficará confirmado.",
    en: "The payment is being processed; it will be confirmed shortly.",
  },
  payment_provider_error: { "pt-BR": "Não foi possível iniciar o pagamento: tente mais tarde.", en: "Couldn't start the payment: try again later." },
  payment_required: { "pt-BR": "Para assinar, primeiro é preciso concluir o pagamento.", en: "To sign, you first need to complete the payment." },

  // ── IA ──
  ai_disabled: { "pt-BR": "A assistência com IA não está disponível aqui.", en: "AI assistance isn't available here." },
  ai_bad_output: { "pt-BR": "A IA respondeu algo inválido: tente de novo.", en: "The AI returned an invalid response: try again." },
  ai_input_too_large: { "pt-BR": "O documento é longo demais para a assistência com IA.", en: "The document is too long for AI assistance." },
  ai_rate_limited: {
    "pt-BR": "O provedor de IA está saturado; tente de novo em um momento.",
    en: "The AI provider is overloaded; try again in a moment.",
  },
  ai_refused: { "pt-BR": "A IA se recusou a responder a este pedido.", en: "The AI declined to answer this request." },
  ai_request_rejected: { "pt-BR": "O provedor de IA rejeitou o pedido.", en: "The AI provider rejected the request." },
  playbook_empty: {
    "pt-BR": "Não há regras para revisar: carregue o playbook em Configurações → IA.",
    en: "There are no rules to review: load the playbook in Settings → AI.",
  },

  // ── Envío de sobres (consola y API) ──
  anchor_not_found: {
    "pt-BR": "O texto âncora de um campo não foi encontrado no documento.",
    en: "A field's anchor text wasn't found in the document.",
  },
  pdf_reader_busy: {
    "pt-BR": "O leitor de PDF está ocupado: tente novamente em alguns segundos.",
    en: "The PDF reader is busy: try again in a few seconds.",
  },
  unreadable_pdf: { "pt-BR": "Não foi possível ler o PDF.", en: "Couldn't read the PDF." },
  unsupported_format: {
    "pt-BR": "Envie um PDF: a conversão de documentos do Word não está disponível.",
    en: "Upload a PDF: Word document conversion isn't available.",
  },
  file_required: { "pt-BR": "Falta o arquivo.", en: "The file is missing." },
  duplicate: { "pt-BR": "Esse PDF já está no repositório.", en: "That PDF is already in the repository." },
  duplicate_document: { "pt-BR": "Uma parte de arquivo foi usada em mais de um documento.", en: "A file part was used in more than one document." },
  duplicate_part: { "pt-BR": "Há uma parte repetida no envio.", en: "A part is repeated in the upload." },
  duplicate_ref: { "pt-BR": "Há documentos ou destinatários com o mesmo ref.", en: "There are documents or recipients with the same ref." },
  file_part_missing: { "pt-BR": "Falta uma parte de arquivo citada por um documento.", en: "A file part referenced by a document is missing." },
  unused_file_part: { "pt-BR": "Há partes de arquivo que nenhum documento cita.", en: "Some file parts aren't referenced by any document." },
  unknown_part: { "pt-BR": "Parte desconhecida no envio.", en: "Unknown part in the upload." },
  payload_required: { "pt-BR": "Falta a parte com o JSON do envelope.", en: "The part with the envelope JSON is missing." },
  payload_too_large: { "pt-BR": "Os dados do envelope são grandes demais.", en: "The envelope data is too large." },
  envelope_required: { "pt-BR": "Indique o envelope.", en: "Specify the envelope." },
  source_required: { "pt-BR": "Falta o documento ou o modelo de origem.", en: "The source document or template is missing." },
  roles_missing: { "pt-BR": "Indique pelo menos um destinatário nas funções.", en: "Specify at least one recipient for the roles." },
  missing_roles: { "pt-BR": "Faltam destinatários para algumas funções.", en: "Some roles are missing recipients." },
  duplicate_role: { "pt-BR": "Uma função tem mais de um destinatário.", en: "A role has more than one recipient." },
  unknown_role: { "pt-BR": "O documento não tem essa função de assinatura.", en: "The document doesn't have that signing role." },
  unknown_roles: {
    "pt-BR": "Alguns signatários não têm espaço de assinatura no documento.",
    en: "Some signers have no signature placeholder in the document.",
  },
  observer_signing_role: {
    "pt-BR": "Um observador não assina: use outro rótulo para ele.",
    en: "An observer doesn't sign: use a different label for them.",
  },
  unknown_prefill: { "pt-BR": "Não há esse campo no modelo para preencher.", en: "There's no such field in the template to prefill." },
  readonly_field: {
    "pt-BR": "Um campo não pode ser preenchido previamente (é somente leitura, calculado ou não leva valor).",
    en: "A field can't be prefilled (it's read-only, calculated, or doesn't take a value).",
  },
  duplicate_prefill: { "pt-BR": "Dois valores diferentes preenchem o mesmo campo.", en: "Two different values prefill the same field." },
  invalid_prefill: { "pt-BR": "Os dados para preencher o modelo são inválidos.", en: "The template prefill data is invalid." },
  invalid_metadata: { "pt-BR": "Algum dado tem formato inválido.", en: "Some data has an invalid format." },
  invalid_channels: {
    "pt-BR": "O canal escolhido exige e-mail (e-mail) ou telefone (WhatsApp).",
    en: "The chosen channel requires an email (email) or phone (WhatsApp).",
  },
  invalid_contact: { "pt-BR": "Falta o e-mail ou o telefone de um destinatário.", en: "A recipient's email or phone is missing." },
  recipient_contact: { "pt-BR": "Falta o e-mail ou o telefone de um destinatário.", en: "A recipient's email or phone is missing." },
  invalid_host: { "pt-BR": "O anfitrião deve ser um usuário da organização.", en: "The host must be a user of the organization." },
  otp_destination_required: {
    "pt-BR": "Este signatário se verifica com um código: informe o e-mail ou telefone da pessoa.",
    en: "This signer is verified with a code: enter the person's email or phone.",
  },
  delegation_requires_id_match: {
    "pt-BR":
      "Este signatário precisa assinar com um certificado que corresponda ao documento de identidade: para delegar, informe o número do documento da pessoa.",
    en: "This signer must sign with a certificate matching their ID document: to delegate, enter the person's document number.",
  },
  not_editable: { "pt-BR": "O envelope não pode mais ser editado.", en: "The envelope can no longer be edited." },
  recipient_immutable: {
    "pt-BR": "Um destinatário já assinou ou concluiu sua participação: não pode ser alterado.",
    en: "A recipient has already signed or finished: they can't be changed.",
  },
  recipient_viewed: { "pt-BR": "O destinatário já abriu o envelope.", en: "The recipient has already opened the envelope." },
  routing_passed: {
    "pt-BR": "O grupo de assinatura do novo destinatário já terminou.",
    en: "The new recipient's signing group has already finished.",
  },
  not_replaceable: { "pt-BR": "Este destinatário não pode ser substituído.", en: "This recipient can't be replaced." },
  too_many_replacements: {
    "pt-BR": "Este envelope já teve delegações ou substituições demais.",
    en: "This envelope has had too many delegations or reassignments.",
  },
  same_person: { "pt-BR": "Você não pode delegar para si mesmo.", en: "You can't delegate to yourself." },
  replaced: { "pt-BR": "Esse destinatário foi substituído.", en: "That recipient was replaced." },
  not_completed: { "pt-BR": "O envelope ainda não está concluído.", en: "The envelope isn't completed yet." },
  not_finalizing: { "pt-BR": "O envelope não está aguardando a finalização.", en: "The envelope isn't waiting to be finalized." },
  logic_cycle: { "pt-BR": "As condições ou fórmulas formam um ciclo.", en: "The conditions or formulas form a cycle." },
  certificate_in_use: {
    "pt-BR": "O certificado está selando envelopes em finalização: aguarde até que terminem.",
    en: "The certificate is sealing envelopes being finalized: wait for them to finish.",
  },

  // ── Selo de arquivo (evidencia) ──
  archive_not_applicable: { "pt-BR": "Este envelope não tem selo de arquivo para renovar.", en: "This envelope has no archive timestamp to renew." },
  archive_not_due: {
    "pt-BR": "O selo de arquivo ainda não está para vencer: renová-lo agora não estenderia a validade.",
    en: "The archive timestamp isn't close to expiring: renewing it now wouldn't extend its validity.",
  },
  archive_recently_renewed: {
    "pt-BR": "O selo de arquivo deste envelope já foi renovado várias vezes hoje.",
    en: "This envelope's archive timestamp has already been renewed several times today.",
  },
  archive_renewal_in_progress: {
    "pt-BR": "Já há uma renovação do selo de arquivo em andamento para este envelope.",
    en: "An archive timestamp renewal is already in progress for this envelope.",
  },
  archive_renewal_limit: {
    "pt-BR": "O envelope atingiu o máximo de renovações do selo de arquivo.",
    en: "The envelope has reached the maximum number of archive timestamp renewals.",
  },
  not_timestamped: {
    "pt-BR": "O PDF não tem carimbo de tempo: não há selo de arquivo para renovar.",
    en: "The PDF has no timestamp: there's no archive to renew.",
  },
  tsa_not_configured: {
    "pt-BR": "Não há TSA configurada para renovar o selo de arquivo.",
    en: "No TSA is configured to renew the archive timestamp.",
  },

  // ── Firmante: código, identidad, certificado, en persona ──
  code_expired: {
    "pt-BR": "O código expirou: gere um novo a partir do link de assinatura.",
    en: "The code expired: generate a new one from the signing link.",
  },
  code_failed: {
    "pt-BR": "O código ficou inválido: gere um novo a partir do link de assinatura.",
    en: "The code is no longer valid: generate a new one from the signing link.",
  },
  code_used: { "pt-BR": "Este código já foi usado ou não é mais válido.", en: "This code was already used or is no longer valid." },
  otp_no_destination: { "pt-BR": "Não há para onde enviar o código.", en: "There's nowhere to send the code." },
  otp_not_required: { "pt-BR": "Este link não exige código.", en: "This link doesn't require a code." },
  document_changed: { "pt-BR": "O documento mudou: recarregue e assine novamente.", en: "The document changed: reload and sign again." },
  recipient_changed: { "pt-BR": "Os dados do signatário mudaram: recarregue a página.", en: "The signer's details changed: reload the page." },
  copy_limit_reached: {
    "pt-BR": "Você já pediu várias cópias. Baixe o documento nesta página.",
    en: "You've already requested several copies. Download the document from this page.",
  },
  copy_recently_requested: {
    "pt-BR": "Você pediu uma cópia há pouco. Verifique seu e-mail ou suas mensagens.",
    en: "You requested a copy a moment ago. Check your email or messages.",
  },
  no_destination: { "pt-BR": "Não há para onde enviar a cópia.", en: "There's nowhere to send the copy." },
  identity_attempts_exhausted: { "pt-BR": "As tentativas de verificação se esgotaram.", en: "The verification attempts are exhausted." },
  identity_confirmation_required: {
    "pt-BR": "Primeiro é preciso confirmar a identidade no dispositivo do anfitrião.",
    en: "Identity must first be confirmed on the host's device.",
  },
  identity_not_applicable: {
    "pt-BR": "A verificação de identidade se aplica a signatários e aprovadores.",
    en: "Identity verification applies to signers and approvers.",
  },
  identity_not_required: { "pt-BR": "Este link não exige verificação de identidade.", en: "This link doesn't require identity verification." },
  invalid_capture: { "pt-BR": "Esta captura não corresponde à verificação pedida.", en: "This capture doesn't match the requested verification." },
  captures_incomplete: { "pt-BR": "Faltam fotos para concluir a verificação.", en: "Photos are missing to complete the verification." },
  no_active_capture: { "pt-BR": "Primeiro inicie a verificação.", en: "Start the verification first." },
  no_active_verification: { "pt-BR": "Não há uma verificação em andamento.", en: "There's no verification in progress." },
  not_in_person: { "pt-BR": "Este link não é de assinatura presencial.", en: "This link isn't for in-person signing." },
  not_signer: { "pt-BR": "Este destinatário não assina.", en: "This recipient doesn't sign." },
  not_available: { "pt-BR": "Isso não está disponível agora.", en: "This isn't available right now." },
  certificate_not_applicable: {
    "pt-BR": "Só um signatário pode assinar com certificado.",
    en: "Only a signer can sign with a certificate.",
  },
  not_certificate_signer: { "pt-BR": "Este destinatário não assina com certificado.", en: "This recipient doesn't sign with a certificate." },
  not_ready: { "pt-BR": "Ainda não é hora de assinar com certificado.", en: "It's not time to sign with a certificate yet." },
  not_prepared: { "pt-BR": "Primeiro é preciso enviar o certificado.", en: "The certificate must be sent first." },
  certificate_expired: { "pt-BR": "O certificado está vencido.", en: "The certificate has expired." },
  certificate_rejected: {
    "pt-BR": "O certificado não atende aos requisitos desta assinatura.",
    en: "The certificate doesn't meet this signature's requirements.",
  },
  certificate_unsupported: { "pt-BR": "Este certificado não é suportado.", en: "This certificate isn't supported." },
  certificate_usage: { "pt-BR": "O certificado não está habilitado para este uso.", en: "The certificate isn't enabled for this use." },
  invalid_certificate: { "pt-BR": "O certificado está faltando ou não pode ser lido.", en: "The certificate is missing or unreadable." },
  signature_failed: { "pt-BR": "O PDF assinado não passa na verificação.", en: "The signed PDF doesn't verify." },
  signature_invalid: {
    "pt-BR": "A assinatura não corresponde ao certificado ou ao documento.",
    en: "The signature doesn't match the certificate or the document.",
  },
  invalid_p12: { "pt-BR": "O arquivo não é um .p12/.pfx válido.", en: "The file isn't a valid .p12/.pfx." },
  invalid_p12_password: {
    "pt-BR": "Não foi possível abrir o arquivo: a senha está incorreta ou o arquivo está danificado.",
    en: "Couldn't open the file: the password is wrong or the file is damaged.",
  },
  p12_key_mismatch: {
    "pt-BR": "Nenhum certificado do arquivo corresponde à chave privada.",
    en: "No certificate in the file matches the private key.",
  },
  p12_without_cert: { "pt-BR": "O arquivo não contém certificados.", en: "The file contains no certificates." },
  p12_without_key: {
    "pt-BR": "O arquivo não contém uma chave privada RSA (só são aceitas chaves RSA).",
    en: "The file doesn't contain an RSA private key (only RSA keys are accepted).",
  },
  xml_sign_failed: { "pt-BR": "Não foi possível assinar o XML.", en: "Couldn't sign the XML." },

  // ── Firmante: firma dibujada en el celular (pase de firma) ──
  invalid_handoff: {
    "pt-BR": "A assinatura do celular não corresponde a este link: desenhe de novo ou peça outro link.",
    en: "The signature from the phone doesn't match this link: draw it again or request another link.",
  },
  handoff_expired: {
    "pt-BR": "O link para desenhar a assinatura expirou ou não vale mais: peça outro na tela onde você está assinando.",
    en: "The link to draw your signature expired or is no longer valid: request another one from the screen where you're signing.",
  },
  handoff_used: {
    "pt-BR": "Esta assinatura já foi enviada: continue na tela onde você está assinando.",
    en: "This signature was already sent: continue on the screen where you're signing.",
  },
  handoff_too_many: {
    "pt-BR": "Você pediu links demais para o celular: tente mais tarde ou desenhe a assinatura nesta tela.",
    en: "You requested too many phone links: try again later or draw your signature on this screen.",
  },
  handoff_channel_unavailable: {
    "pt-BR": "Esse canal não está disponível (no Telegram, só se você já vinculou seu chat): copie o link ou escolha outro canal.",
    en: "That channel isn't available (Telegram only works if you already linked your chat): copy the link or choose another channel.",
  },
  handoff_cooldown: {
    "pt-BR": "Aguarde alguns segundos para enviar o link de novo.",
    en: "Wait a few seconds before sending the link again.",
  },
  handoff_send_limit: {
    "pt-BR": "Você já enviou o link vezes demais: copie e cole no chat, ou tente mais tarde.",
    en: "You've sent the link too many times: copy and paste it into the chat, or try again later.",
  },
  handoff_destination_limit: {
    "pt-BR": "Foram enviadas mensagens demais para esse destino: copie o link ou tente mais tarde.",
    en: "Too many messages were sent to that destination: copy the link or try again later.",
  },
  handoff_delivery_failed: {
    "pt-BR": "Não foi possível enviar o link: copie e cole no chat, ou tente de novo em alguns segundos.",
    en: "The link couldn't be sent: copy and paste it into the chat, or try again in a few seconds.",
  },
  // ── Formularios web y envíos masivos ──
  captcha_failed: {
    "pt-BR": "Não foi possível verificar que você não é um robô: conclua a verificação e envie novamente.",
    en: "Couldn't verify that you're not a robot: complete the check and submit again.",
  },
  invalid_form: {
    "pt-BR": "O modelo não fica completo com esta configuração do formulário.",
    en: "The template isn't complete with this form configuration.",
  },
  invalid_form_token: {
    "pt-BR": "O formulário expirou: envie novamente em alguns segundos.",
    en: "The form expired: submit it again in a few seconds.",
  },
  too_fast: { "pt-BR": "Aguarde alguns segundos e envie novamente.", en: "Wait a few seconds and submit again." },
  phone_required: { "pt-BR": "O telefone é obrigatório.", en: "The phone number is required." },
  rejected: { "pt-BR": "Não foi possível processar o pedido.", en: "Couldn't process the request." },
  template_deleted: { "pt-BR": "O modelo foi excluído.", en: "The template was deleted." },
  no_rows: { "pt-BR": "Não há linhas para enviar.", en: "There are no rows to send." },
  rows_invalid: { "pt-BR": "Há linhas com erros: corrija-as ou pule as inválidas.", en: "Some rows have errors: fix them or skip the invalid ones." },
  too_many_rows: { "pt-BR": "Linhas demais para um envio.", en: "Too many rows for one send." },
  not_cancellable: { "pt-BR": "O envio já terminou.", en: "The send has already finished." },

  // ── Acuerdos, documentos, cláusulas, workflows, negociaciones ──
  duplicate_key: { "pt-BR": "Já existe um campo com essa chave.", en: "A field with that key already exists." },
  immutable_key: { "pt-BR": "A chave de um campo não pode ser alterada.", en: "A field's key can't be changed." },
  duplicate_slug: { "pt-BR": "Já existe uma cláusula com esse código.", en: "A clause with that code already exists." },
  immutable_slug: {
    "pt-BR": "O código de uma cláusula não pode ser alterado (os modelos o citam).",
    en: "A clause's code can't be changed (templates reference it).",
  },
  unknown_clause: { "pt-BR": "A cláusula não está no documento.", en: "The clause isn't in the document." },
  missing_clauses: { "pt-BR": "O documento cita cláusulas que não existem.", en: "The document references clauses that don't exist." },
  missing_variables: { "pt-BR": "Faltam dados para gerar o documento.", en: "Some data is missing to generate the document." },
  not_external: {
    "pt-BR": "Só acordos externos podem ser excluídos; os assinados no CalaSign são encerrados (status: encerrado).",
    en: "Only external agreements can be deleted; those signed in CalaSign are terminated (status: terminated).",
  },
  inactive: { "pt-BR": "O workflow está desativado.", en: "The workflow is deactivated." },
  duplicate_step: { "pt-BR": "Há etapas com o mesmo id.", en: "Some steps have the same ID." },
  invalid_step: { "pt-BR": "Uma etapa do workflow está mal configurada.", en: "A workflow step is misconfigured." },
  invalid_template: { "pt-BR": "O modelo de documento de uma etapa não existe.", en: "A step's document template doesn't exist." },
  invalid_approver: {
    "pt-BR": "Quem aprova uma etapa não é membro da organização.",
    en: "A step's approver isn't a member of the organization.",
  },
  not_active: { "pt-BR": "A execução já terminou.", en: "The run has already finished." },
  not_failed: { "pt-BR": "Só uma execução com uma etapa com falha pode ser repetida.", en: "Only a run with a failed step can be retried." },
  runs_in_progress: { "pt-BR": "Há execuções em andamento: cancele-as primeiro.", en: "There are runs in progress: cancel them first." },
  decided: { "pt-BR": "A proposta já foi decidida.", en: "The proposal has already been decided." },
  not_negotiable: { "pt-BR": "Esse ponto não pode ser negociado.", en: "That item can't be negotiated." },
  pending_proposals: { "pt-BR": "Há propostas ainda não decididas.", en: "Some proposals haven't been decided yet." },
  proposal_outdated: {
    "pt-BR": "O texto mudou desde que a proposta foi feita: rejeite-a e peça uma nova.",
    en: "The text changed since the proposal was made: reject it and ask for a new one.",
  },
  runs_with_open_envelopes: {
    "pt-BR": "Uma execução com falha deixou envelopes em assinatura: cancele a execução primeiro (isso anula esses envelopes).",
    en: "A failed run left envelopes out for signature: cancel the run first (that voids those envelopes).",
  },
  invalid_path: { "pt-BR": "Caminho de variável inválido.", en: "Invalid variable path." },
  run_purged: {
    "pt-BR": "Os dados desta execução foram apagados pela política de retenção: inicie uma nova execução.",
    en: "This run's data was deleted by the retention policy: start a new run.",
  },
  verification_not_started: {
    "pt-BR": "A verificação ainda não começou no provedor: toque em continuar para abrir a página de verificação.",
    en: "The verification hasn't started at the provider yet: tap continue to open the verification page.",
  },
  currency_not_supported: {
    "pt-BR": "O Mercado Pago só cobra na moeda da conta: escolha essa moeda ou outro provedor.",
    en: "Mercado Pago only charges in its account's currency: choose that currency or another provider.",
  },
  identity_level_not_supported: {
    "pt-BR":
      "A verificação de identidade não pode ser concluída com a configuração atual do provedor: escolha outro nível ou provedor (ou corrija a configuração) e reinicie-a.",
    en: "The identity verification can't be completed with the provider's current setup: choose another level or provider (or fix the setup) and restart it.",
  },
  payment_webhook_not_configured: {
    "pt-BR":
      "O provedor de cobrança não tem o segredo do webhook configurado neste ambiente e o pagamento não poderia ser confirmado: remova a cobrança do envelope ou escolha outro provedor.",
    en: "The payment provider has no webhook secret configured in this environment, so the payment couldn't be confirmed: remove the payment from the envelope or choose another provider.",
  },
  metadata_changed: {
    "pt-BR":
      "Os metadados do contrato mudaram enquanto eram extraídos (alguém os editou ou extraiu de novo): revise-os e, se necessário, extraia-os novamente.",
    en: "The contract metadata changed while it was being extracted (someone edited it or extracted it again): review it and, if needed, extract it again.",
  },
  reauth_required: {
    "pt-BR": "Confirme sua senha para continuar (ou, se sua conta não tem senha, entre novamente e repita a ação em até 10 minutos).",
    en: "Confirm your password to continue (or, if your account has no password, sign in again and repeat the action within 10 minutes).",
  },
  invalid_password: { "pt-BR": "A senha não está correta.", en: "The password is incorrect." },
};
