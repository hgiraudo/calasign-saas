import type { IDataObject, IHookFunctions, INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { calaSignRequest, verifySignature } from "../GenericFunctions";
import { flattenEvent } from "../quicksend";

const EVENTS = [
  "envelope.sent",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
  "recipient.viewed",
  "recipient.signed",
  "recipient.declined",
  "recipient.approved",
];

/** Status HTTP de un error de httpRequestWithAuthentication (NodeApiError, error de axios o similar), si lo hay. */
function httpStatus(error: unknown): number | undefined {
  const e = error as {
    httpCode?: unknown;
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown; response?: { status?: unknown } };
  };
  for (const v of [e?.httpCode, e?.response?.status, e?.statusCode, e?.status, e?.cause?.response?.status, e?.cause?.status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100) return n;
  }
  return undefined;
}

export class CalaSignTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "CalaSign Trigger",
    name: "calaSignTrigger",
    icon: { light: "file:calasign.svg", dark: "file:calasign.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: "Starts the workflow on CalaSign envelope and recipient events",
    defaults: { name: "CalaSign Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      { name: "calaSignApi", required: true, displayOptions: { show: { authentication: ["apiKey"] } } },
      { name: "calaSignOAuth2Api", required: true, displayOptions: { show: { authentication: ["oAuth2"] } } },
    ],
    webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "webhook" }],
    properties: [
      {
        displayName: "Authentication",
        name: "authentication",
        type: "options",
        options: [
          { name: "API Key", value: "apiKey" },
          { name: "OAuth2", value: "oAuth2" },
        ],
        default: "apiKey",
      },
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: EVENTS.map((e) => ({ name: e, value: e })),
        default: ["envelope.completed"],
        required: true,
      },
      {
        displayName: "Simplify",
        name: "simplify",
        type: "boolean",
        default: true,
        description: "Whether to return flat fields (envelope_id, envelope_status, recipient_email…) instead of the raw event",
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (!data.webhookId) return false;
        const path = `/v1/webhooks/${encodeURIComponent(String(data.webhookId))}`;
        let ep: IDataObject;
        try {
          ep = await calaSignRequest(this, "GET", path);
        } catch (error) {
          // Solo si el webhook ya no existe o no es accesible con esta credencial (404/401/403) se descarta el id y se
          // registra otro. Ante otro error (5xx, red) se propaga: crear otro dejaba el anterior vivo, duplicando eventos.
          const status = httpStatus(error);
          if (status !== 404 && status !== 401 && status !== 403) throw error;
          this.logger.debug("CalaSign: webhook no encontrado, se registra de nuevo", { error: (error as Error).message });
          delete data.webhookId;
          delete data.secret;
          return false;
        }
        if (ep.url === this.getNodeWebhookUrl("default")) {
          if (ep.active) return true;
          // Inactivo porque se revocó la credencial que lo creó (p. ej. al reconectar la cuenta): reactivarlo lo ata a
          // la credencial actual y conserva id y secreto.
          if (ep.deactivatedReason === "credential_revoked") {
            try {
              const re = await calaSignRequest(this, "PATCH", path, { body: { active: true, events: this.getNodeParameter("events") as string[] } });
              if (re.active) return true;
            } catch (error) {
              this.logger.debug("CalaSign: no se pudo reactivar el webhook, se registra de nuevo", { error: (error as Error).message });
            }
            // No se pudo reactivar: se borra antes de crear otro, para no acumular webhooks inactivos (máximo 20).
            try {
              await calaSignRequest(this, "DELETE", path);
            } catch (error) {
              this.logger.debug("CalaSign: no se pudo borrar el webhook inactivo", { error: (error as Error).message });
            }
          } else {
            // Pausado a mano en CalaSign (o una API sin deactivatedReason): no se reactiva ni se crea otro a sus
            // espaldas. Se avisa para que el usuario decida.
            throw new NodeOperationError(
              this.getNode(),
              `The CalaSign webhook for this workflow (${String(data.webhookId)}) is paused in CalaSign. Reactivate it (Developers → Webhooks) or delete it there, then activate the workflow again.`,
            );
          }
        }
        delete data.webhookId;
        delete data.secret;
        return false;
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const res = await calaSignRequest<{ webhook: { id: string }; secret: string }>(this, "POST", "/v1/webhooks", {
          body: {
            url: this.getNodeWebhookUrl("default") as string,
            events: this.getNodeParameter("events") as string[],
            description: `n8n: ${this.getWorkflow().name ?? this.getWorkflow().id}`,
          },
        });
        const data = this.getWorkflowStaticData("node");
        data.webhookId = res.webhook.id;
        data.secret = res.secret;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (data.webhookId) {
          try {
            await calaSignRequest(this, "DELETE", `/v1/webhooks/${encodeURIComponent(String(data.webhookId))}`);
          } catch (error) {
            // Ya no existe del lado de CalaSign: no hay nada que borrar.
            this.logger.debug("CalaSign: no se pudo borrar el webhook (ya no existe)", { error: (error as Error).message });
          }
        }
        delete data.webhookId;
        delete data.secret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject() as unknown as { rawBody?: Buffer; headers: Record<string, string | undefined> };
    const secret = this.getWorkflowStaticData("node").secret as string | undefined;
    // Sin el cuerpo crudo no se puede verificar: se rechaza (antes se aceptaba sin verificar).
    if (secret && (!req.rawBody || !verifySignature(secret, req.headers["calasign-signature"], req.rawBody))) {
      const res = this.getResponseObject();
      res.status(401).json({ error: "invalid signature" });
      return { noWebhookResponse: true };
    }
    const body = this.getBodyData() as IDataObject;
    const events = this.getNodeParameter("events") as string[];
    if (!body.type || body.type === "webhook.test" || (events.length && !events.includes(String(body.type)))) return { workflowData: [] };
    const json = this.getNodeParameter("simplify", true) ? (flattenEvent(body) as IDataObject) : body;
    return { workflowData: [this.helpers.returnJsonArray(json)] };
  }
}
