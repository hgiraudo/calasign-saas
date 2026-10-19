// Textos de recuperación de contraseña.
import { useI18n } from "./i18n";

const es = {
  forgotLink: "¿Olvidaste tu contraseña?",
  forgotTitle: "Recuperar contraseña",
  forgotIntro: "Escribí el correo de tu cuenta y te mandamos un link para elegir una contraseña nueva.",
  send: "Enviar link",
  sent: "Si existe una cuenta con ese correo, te enviamos un link para restablecer la contraseña. Vale 30 minutos.",
  backToLogin: "Volver a ingresar",
  resetTitle: "Elegí una contraseña nueva",
  newPassword: "Contraseña nueva",
  confirmPassword: "Repetí la contraseña",
  mismatch: "Las contraseñas no coinciden",
  save: "Guardar contraseña",
  done: "Listo: tu contraseña cambió y se cerraron las sesiones abiertas. Ya podés ingresar.",
  invalid: "El link no es válido o ya venció. Pedí uno nuevo.",
  requestNew: "Pedir un link nuevo",
  resetRequired: "Tu acceso se creó con inicio de sesión único (SSO) o SCIM. Para ingresar con contraseña, primero restablecela.",
  resetRequiredAction: "Restablecer contraseña",
  notAllowed: "En esa organización tu acceso se creó con inicio de sesión único (SSO) o SCIM: ingresá con SSO o restablecé tu contraseña para usarla ahí.",
  sessionExpired: "Tu sesión terminó (venció o se cerró). Volvé a ingresar para seguir donde estabas.",
  badCredentials: "Correo o contraseña incorrectos.",
};
type Key = keyof typeof es;

const pt: Record<Key, string> = {
  forgotLink: "Esqueceu sua senha?",
  forgotTitle: "Recuperar senha",
  forgotIntro: "Digite o e-mail da sua conta e enviaremos um link para escolher uma nova senha.",
  send: "Enviar link",
  sent: "Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha. Ele vale 30 minutos.",
  backToLogin: "Voltar para entrar",
  resetTitle: "Escolha uma nova senha",
  newPassword: "Nova senha",
  confirmPassword: "Repita a senha",
  mismatch: "As senhas não coincidem",
  save: "Salvar senha",
  done: "Pronto: sua senha mudou e as sessões abertas foram encerradas. Você já pode entrar.",
  invalid: "O link não é válido ou expirou. Peça um novo.",
  requestNew: "Pedir um novo link",
  resetRequired: "Seu acesso foi criado com login único (SSO) ou SCIM. Para entrar com senha, redefina-a primeiro.",
  resetRequiredAction: "Redefinir senha",
  notAllowed: "Nessa organização seu acesso foi criado com login único (SSO) ou SCIM: entre com SSO ou redefina sua senha para usá-la lá.",
  sessionExpired: "Sua sessão terminou (expirou ou foi encerrada). Entre novamente para continuar de onde parou.",
  badCredentials: "E-mail ou senha incorretos.",
};

const en: Record<Key, string> = {
  forgotLink: "Forgot your password?",
  forgotTitle: "Recover password",
  forgotIntro: "Enter your account email and we'll send you a link to choose a new password.",
  send: "Send link",
  sent: "If an account exists for that email, we sent a link to reset the password. It is valid for 30 minutes.",
  backToLogin: "Back to sign in",
  resetTitle: "Choose a new password",
  newPassword: "New password",
  confirmPassword: "Repeat the password",
  mismatch: "Passwords don't match",
  save: "Save password",
  done: "Done: your password changed and open sessions were closed. You can sign in now.",
  invalid: "The link is invalid or expired. Request a new one.",
  requestNew: "Request a new link",
  resetRequired: "Your access was created through single sign-on (SSO) or SCIM. To sign in with a password, reset it first.",
  resetRequiredAction: "Reset password",
  notAllowed: "In that organization your access was created through single sign-on (SSO) or SCIM: sign in with SSO or reset your password to use it there.",
  sessionExpired: "Your session ended (it expired or was closed). Sign in again to pick up where you left off.",
  badCredentials: "Incorrect email or password.",
};

const DICTS: Record<string, Record<Key, string>> = { es, "pt-BR": pt, en };

export function usePasswordText() {
  const { locale } = useI18n();
  const d = DICTS[locale] ?? es;
  return (k: Key) => d[k] ?? es[k];
}
