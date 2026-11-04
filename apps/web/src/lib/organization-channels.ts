// Canales de terceros que la organización permite (Ajustes → Organización; migración 0128): los selectores de canal y
// de verificación no ofrecen los apagados. Es solo conveniencia: la API rechaza un canal apagado (400 channel_disabled).
import { useEffect, useState } from "react";
import { DEFAULT_ORGANIZATION_CHANNELS, type OrganizationChannels, type OrganizationSettings } from "@calasign/shared";
import { api } from "./api";

/**
 * Los canales permitidos, pedidos una vez al montar (sin caché entre pantallas: si un administrador los cambia en otra
 * pestaña o se cambia de organización, la próxima pantalla ya lo ve). Mientras carga, o si el pedido falla, los tres
 * encendidos: lo que se elija de más lo frena la API con un mensaje que dice qué cambiar.
 */
export function useOrganizationChannels(): OrganizationChannels {
  const [v, setV] = useState<OrganizationChannels>(DEFAULT_ORGANIZATION_CHANNELS);
  useEffect(() => {
    let vivo = true;
    api<OrganizationSettings>("/v1/settings/organization").then(
      (x) => vivo && x.channels && setV(x.channels),
      () => {}, // sin los ajustes se ofrecen todos (la API valida igual)
    );
    return () => {
      vivo = false;
    };
  }, []);
  return v;
}
