// Textos de Ajustes → Organización (huso horario).
import { interpolate } from "./interpolate";
import { useI18n } from "./i18n";

const es = {
  "org.card": "Organización",
  "org.cardDesc": "Huso horario de las horas del certificado y de la fecha de firma.",
  "org.title": "Organización",
  "org.intro":
    "El huso horario con el que se escriben las horas del certificado de finalización y la fecha de los campos «Fecha de firma» del PDF, siempre con su desfase respecto de UTC. Se aplica a los sobres que se completen después del cambio.",
  "org.timeZone": "Huso horario",
  "org.now": "Ahora en ese huso: {time}",
  "org.save": "Guardar",
  "org.saved": "Guardado.",
  "org.readOnly": "Solo un administrador con permiso para cambiar los ajustes puede modificarlo.",
};
type Key = keyof typeof es;

const pt: Record<Key, string> = {
  "org.card": "Organização",
  "org.cardDesc": "Fuso horário das horas do certificado e da data de assinatura.",
  "org.title": "Organização",
  "org.intro":
    "O fuso horário em que são escritas as horas do certificado de conclusão e a data dos campos «Data de assinatura» do PDF, sempre com a diferença em relação ao UTC. Vale para os envelopes concluídos depois da mudança.",
  "org.timeZone": "Fuso horário",
  "org.now": "Agora nesse fuso: {time}",
  "org.save": "Salvar",
  "org.saved": "Salvo.",
  "org.readOnly": "Somente um administrador com permissão para alterar as configurações pode modificá-lo.",
};

const en: Record<Key, string> = {
  "org.card": "Organization",
  "org.cardDesc": "Time zone for the certificate times and the signing date.",
  "org.title": "Organization",
  "org.intro":
    "The time zone used for the times in the certificate of completion and for the “Date signed” fields in the PDF, always shown with its offset from UTC. It applies to envelopes completed after the change.",
  "org.timeZone": "Time zone",
  "org.now": "Now in that time zone: {time}",
  "org.save": "Save",
  "org.saved": "Saved.",
  "org.readOnly": "Only an administrator allowed to change settings can modify it.",
};

const DICTS: Record<string, Record<Key, string>> = { es, "pt-BR": pt, en };

export function useOrganizationText() {
  const { locale } = useI18n();
  const d = DICTS[locale] ?? es;
  return (k: Key, vars?: Record<string, string | number>) => interpolate(d[k] ?? es[k], vars);
}
