// Textos de la firma con certificado propio (Firmador CalaSign). Diccionario propio para no tocar lib/i18n.tsx.
import { interpolate } from "./interpolate";
import { brandText } from "./white-label";
import { useI18n } from "./i18n";

const es = {
  "edit.signatureType": "Tipo de firma",
  "edit.signatureType.electronic": "Firma electrónica",
  "edit.signatureType.certificate": "Firma con certificado digital",
  "edit.certHint":
    "Además de la firma electrónica, firma con su certificado (token USB, certificado instalado o archivo .p12) usando el Firmador CalaSign.",
  "edit.certMatch": "El certificado tiene que corresponder a su documento de identidad",
  "edit.certMatchNoDoc": "Falta el número de documento: cargalo en el destinatario o desmarcá esta opción (sin documento no se puede guardar).",
  "edit.certMatchOffer": "Tiene número de documento cargado: podés exigir que el certificado corresponda a ese documento.",
  "edit.certMatchEnable": "Exigirlo",
  "edit.certMatchTemplate":
    "En una plantilla no se puede exigir que el certificado corresponda al documento de identidad: el número se carga en cada sobre (podés pedirlo al editar el sobre).",
  "edit.certQualified": "Solo certificados de autoridades certificantes de confianza",
  "edit.certIssuers": "Emisores permitidos (opcional)",
  "edit.certIssuersHint": "Partes del nombre del emisor, separadas por coma. Ej.: ICP-Brasil, RENIEC, Certicámara",

  "detail.certTitle": "Firmas con certificado digital",
  "detail.certIntro":
    "Después de la firma electrónica, estos firmantes firman en orden con su certificado. El sello de la plataforma se agrega al final.",
  "detail.certPending": "Pendiente",
  "detail.certSigned": "Firmado",
  "detail.certSerial": "Serie",

  "sign.certTitle": "Firma con tu certificado digital",
  "sign.certWaiting": "Cuando todas las partes firmen, te avisamos para que firmes con tu certificado ({position} de {total}).",
  "sign.certYourTurn":
    "Falta tu firma con certificado digital. Se hace con el Firmador CalaSign, en tu computadora: tu clave privada no sale de tu token ni de tu equipo.",
  "sign.certSteps1": "Si no lo tenés, descargá e instalá el Firmador CalaSign.",
  "sign.certSteps2": "Generá un código y abrí el Firmador (o pegá el código).",
  "sign.certSteps3": "Elegí tu certificado, ingresá el PIN o la contraseña y firmá.",
  "sign.certDownload": "Descargar el Firmador",
  "sign.certGetCode": "Generar código",
  "sign.certCode": "Tu código",
  "sign.certCodeExpires": "Vence a las {time}. Es de un solo uso.",
  "sign.certOpen": "Abrir el Firmador",
  "sign.certWaitingSignature": "Esperando la firma desde el Firmador…",
  "sign.certSignedTitle": "Firmaste con tu certificado",
  "sign.certSignedWith": "Certificado: {cn} · Emisor: {issuer}",
  "sign.certRequirements": "Requisitos: {list}",
  "sign.certReqMatch": "que el certificado sea tuyo (según tu documento)",
  "sign.certReqQualified": "emitido por una autoridad de confianza",
  "sign.certReqIssuers": "emisor: {list}",

  "firmador.title": "Firmador CalaSign",
  "firmador.intro":
    "La aplicación que firma documentos de CalaSign con tu certificado digital: un token USB, un certificado instalado en tu computadora o un archivo .p12/.pfx. Tu clave privada nunca sale de tu equipo.",
  "firmador.downloads": "Descargas",
  "firmador.soon": "Próximamente para tu sistema. Mientras tanto, pedile el instalador a la organización que te envió el documento.",
  "firmador.size": "{mb} MB · SHA-256 {sha}",
  "firmador.windows": "Windows",
  "firmador.windowsSteps":
    "Descargá el .exe y ejecutalo. Usa los certificados de Windows (incluidos los de tokens que se instalan ahí) y archivos .p12. La primera vez, registrá el enlace con: calasign-firmador.exe register-protocol",
  "firmador.linux": "Linux",
  "firmador.linuxSteps":
    "Descargá el archivo, dale permiso de ejecución (chmod +x) y ejecutalo. Para tokens USB copiá la carpeta del módulo PKCS#11 junto al ejecutable. Registrá el enlace con: ./calasign-firmador-linux-x64 register-protocol",
  "firmador.macos": "macOS",
  "firmador.tokens": "Tokens compatibles",
  "firmador.tokensText":
    "Cualquier token o tarjeta con módulo PKCS#11: SafeNet eToken, Feitian ePass, Bit4id, Watchdata (ICP-Brasil), DNI electrónico con OpenSC y otros.",
};

type Key = keyof typeof es;

const pt: Record<Key, string> = {
  "edit.signatureType": "Tipo de assinatura",
  "edit.signatureType.electronic": "Assinatura eletrônica",
  "edit.signatureType.certificate": "Assinatura com certificado digital",
  "edit.certHint":
    "Além da assinatura eletrônica, assina com seu certificado (token USB, certificado instalado ou arquivo .p12) usando o Firmador CalaSign.",
  "edit.certMatch": "O certificado deve corresponder ao documento de identidade",
  "edit.certMatchNoDoc": "Falta o número do documento: informe-o no destinatário ou desmarque esta opção (sem documento não é possível salvar).",
  "edit.certMatchOffer": "O número do documento está informado: você pode exigir que o certificado corresponda a esse documento.",
  "edit.certMatchEnable": "Exigir",
  "edit.certMatchTemplate":
    "Em um modelo não é possível exigir que o certificado corresponda ao documento de identidade: o número é informado em cada envelope (você pode pedir isso ao editar o envelope).",
  "edit.certQualified": "Somente certificados de autoridades certificadoras confiáveis",
  "edit.certIssuers": "Emissores permitidos (opcional)",
  "edit.certIssuersHint": "Partes do nome do emissor, separadas por vírgula. Ex.: ICP-Brasil, RENIEC, Certicámara",
  "detail.certTitle": "Assinaturas com certificado digital",
  "detail.certIntro":
    "Depois da assinatura eletrônica, estes signatários assinam em ordem com seu certificado. O selo da plataforma é adicionado no final.",
  "detail.certPending": "Pendente",
  "detail.certSigned": "Assinado",
  "detail.certSerial": "Série",
  "sign.certTitle": "Assinatura com seu certificado digital",
  "sign.certWaiting": "Quando todas as partes assinarem, avisaremos para você assinar com seu certificado ({position} de {total}).",
  "sign.certYourTurn":
    "Falta a sua assinatura com certificado digital. Ela é feita com o Firmador CalaSign, no seu computador: sua chave privada não sai do token nem do seu equipamento.",
  "sign.certSteps1": "Se ainda não tem, baixe e instale o Firmador CalaSign.",
  "sign.certSteps2": "Gere um código e abra o Firmador (ou cole o código).",
  "sign.certSteps3": "Escolha seu certificado, digite o PIN ou a senha e assine.",
  "sign.certDownload": "Baixar o Firmador",
  "sign.certGetCode": "Gerar código",
  "sign.certCode": "Seu código",
  "sign.certCodeExpires": "Expira às {time}. Uso único.",
  "sign.certOpen": "Abrir o Firmador",
  "sign.certWaitingSignature": "Aguardando a assinatura no Firmador…",
  "sign.certSignedTitle": "Você assinou com seu certificado",
  "sign.certSignedWith": "Certificado: {cn} · Emissor: {issuer}",
  "sign.certRequirements": "Requisitos: {list}",
  "sign.certReqMatch": "que o certificado seja seu (conforme seu documento)",
  "sign.certReqQualified": "emitido por uma autoridade confiável",
  "sign.certReqIssuers": "emissor: {list}",
  "firmador.title": "Firmador CalaSign",
  "firmador.intro":
    "O aplicativo que assina documentos da CalaSign com seu certificado digital: um token USB, um certificado instalado no computador ou um arquivo .p12/.pfx. Sua chave privada nunca sai do seu equipamento.",
  "firmador.downloads": "Downloads",
  "firmador.soon": "Em breve para o seu sistema. Enquanto isso, peça o instalador à organização que enviou o documento.",
  "firmador.size": "{mb} MB · SHA-256 {sha}",
  "firmador.windows": "Windows",
  "firmador.windowsSteps":
    "Baixe o .exe e execute. Usa os certificados do Windows (inclusive os de tokens instalados ali) e arquivos .p12. Na primeira vez, registre o link com: calasign-firmador.exe register-protocol",
  "firmador.linux": "Linux",
  "firmador.linuxSteps":
    "Baixe o arquivo, dê permissão de execução (chmod +x) e execute. Para tokens USB copie a pasta do módulo PKCS#11 junto ao executável. Registre o link com: ./calasign-firmador-linux-x64 register-protocol",
  "firmador.macos": "macOS",
  "firmador.tokens": "Tokens compatíveis",
  "firmador.tokensText":
    "Qualquer token ou cartão com módulo PKCS#11: SafeNet eToken, Feitian ePass, Bit4id, Watchdata (ICP-Brasil), DNI eletrônico com OpenSC e outros.",
};

const en: Record<Key, string> = {
  "edit.signatureType": "Signature type",
  "edit.signatureType.electronic": "Electronic signature",
  "edit.signatureType.certificate": "Digital certificate signature",
  "edit.certHint":
    "On top of the electronic signature, they sign with their certificate (USB token, installed certificate or .p12 file) using the CalaSign Signer app.",
  "edit.certMatch": "The certificate must match their ID document",
  "edit.certMatchNoDoc": "The ID document number is missing: enter it for the recipient or uncheck this option (it can't be saved without it).",
  "edit.certMatchOffer": "An ID document number is entered: you can require the certificate to match that document.",
  "edit.certMatchEnable": "Require it",
  "edit.certMatchTemplate":
    "A template can't require the certificate to match the ID document: the number is entered on each envelope (you can require it when editing the envelope).",
  "edit.certQualified": "Only certificates from trusted certification authorities",
  "edit.certIssuers": "Allowed issuers (optional)",
  "edit.certIssuersHint": "Parts of the issuer name, comma separated. E.g.: ICP-Brasil, RENIEC, Certicámara",
  "detail.certTitle": "Digital certificate signatures",
  "detail.certIntro": "After the electronic signature, these signers sign in order with their certificate. The platform seal is added last.",
  "detail.certPending": "Pending",
  "detail.certSigned": "Signed",
  "detail.certSerial": "Serial",
  "sign.certTitle": "Sign with your digital certificate",
  "sign.certWaiting": "Once everyone has signed, we'll let you know so you can sign with your certificate ({position} of {total}).",
  "sign.certYourTurn":
    "Your digital-certificate signature is pending. It is done with the CalaSign Signer app on your computer: your private key never leaves your token or device.",
  "sign.certSteps1": "If you don't have it yet, download and install the CalaSign Signer.",
  "sign.certSteps2": "Generate a code and open the Signer (or paste the code).",
  "sign.certSteps3": "Pick your certificate, enter the PIN or password and sign.",
  "sign.certDownload": "Download the Signer",
  "sign.certGetCode": "Generate code",
  "sign.certCode": "Your code",
  "sign.certCodeExpires": "Expires at {time}. Single use.",
  "sign.certOpen": "Open the Signer",
  "sign.certWaitingSignature": "Waiting for the signature from the Signer…",
  "sign.certSignedTitle": "You signed with your certificate",
  "sign.certSignedWith": "Certificate: {cn} · Issuer: {issuer}",
  "sign.certRequirements": "Requirements: {list}",
  "sign.certReqMatch": "the certificate must be yours (per your ID)",
  "sign.certReqQualified": "issued by a trusted authority",
  "sign.certReqIssuers": "issuer: {list}",
  "firmador.title": "CalaSign Signer",
  "firmador.intro":
    "The app that signs CalaSign documents with your digital certificate: a USB token, a certificate installed on your computer or a .p12/.pfx file. Your private key never leaves your device.",
  "firmador.downloads": "Downloads",
  "firmador.soon": "Coming soon for your system. Meanwhile, ask the organization that sent you the document for the installer.",
  "firmador.size": "{mb} MB · SHA-256 {sha}",
  "firmador.windows": "Windows",
  "firmador.windowsSteps":
    "Download the .exe and run it. It uses Windows certificates (including tokens registered there) and .p12 files. The first time, register the link with: calasign-firmador.exe register-protocol",
  "firmador.linux": "Linux",
  "firmador.linuxSteps":
    "Download the file, make it executable (chmod +x) and run it. For USB tokens, copy the PKCS#11 module folder next to the executable. Register the link with: ./calasign-firmador-linux-x64 register-protocol",
  "firmador.macos": "macOS",
  "firmador.tokens": "Supported tokens",
  "firmador.tokensText":
    "Any token or smart card with a PKCS#11 module: SafeNet eToken, Feitian ePass, Bit4id, Watchdata (ICP-Brasil), electronic ID cards with OpenSC and more.",
};

const DICTS = { es, "pt-BR": pt, en } as const;
export type CertsignKey = Key;

export function useCertsignText() {
  const { locale } = useI18n();
  const d = (DICTS as Record<string, Record<Key, string>>)[locale] ?? es;
  return (k: Key, vars?: Record<string, string | number>) => {
    const s = brandText(locale, k, d[k] ?? es[k]);
    return interpolate(s, vars);
  };
}
