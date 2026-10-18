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
};

const DICTS: Record<string, Record<Key, string>> = { es, "pt-BR": pt, en };

export function usePasswordText() {
  const { locale } = useI18n();
  const d = DICTS[locale] ?? es;
  return (k: Key) => d[k] ?? es[k];
}
