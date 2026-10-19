import { createHmac, timingSafeEqual } from 'crypto';
import type { IDataObject, IExecuteFunctions, IHookFunctions, IHttpRequestMethods, IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';

type Ctx = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

export const DEFAULT_BASE_URL = '{{BASE_URL}}';

export function credentialType(ctx: Ctx, itemIndex = 0): 'calaSignApi' | 'calaSignOAuth2Api' {
	let auth = 'apiKey';
	try {
		auth = (ctx as IExecuteFunctions).getNodeParameter('authentication', itemIndex, 'apiKey') as string;
	} catch {
		auth = 'apiKey';
	}
	return auth === 'oAuth2' ? 'calaSignOAuth2Api' : 'calaSignApi';
}

export async function baseUrl(ctx: Ctx, itemIndex = 0): Promise<string> {
	const creds = await ctx.getCredentials(credentialType(ctx, itemIndex));
	return String(creds.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Pedido autenticado a la API de CalaSign. `body` Buffer = cuerpo crudo (multipart). */
/** Pedido autenticado a la API de CalaSign. T: forma de la respuesta JSON (o ArrayBuffer con binary). */
export async function calaSignRequest<T = IDataObject>(
	ctx: Ctx,
	method: IHttpRequestMethods,
	path: string,
	opts: { body?: IDataObject | Buffer; qs?: IDataObject; headers?: IDataObject; binary?: boolean } = {},
	itemIndex = 0,
): Promise<T> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(ctx, itemIndex)}${path}`,
		headers: { 'User-Agent': 'CalaSign-n8n/{{VERSION}}', ...(opts.headers ?? {}) },
		qs: opts.qs,
		json: !Buffer.isBuffer(opts.body) && !opts.binary,
	};
	if (opts.body !== undefined) options.body = opts.body;
	if (opts.binary) options.encoding = 'arraybuffer';
	return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, credentialType(ctx, itemIndex), options)) as T;
}

/**
 * Idempotency-Key de un envío: ejecución + nodo + corrida del nodo + item. Si n8n reintenta el nodo (Retry On Fail) para
 * el mismo item, la API devuelve el mismo sobre en lugar de crear otro. La corrida (runIndex) distingue las vueltas de un
 * bucle (Loop Over Items): sin ella, cada vuelta repetía la clave del item 0 y recibía el sobre de la primera (o un 409).
 * Sin id de ejecución (contextos de prueba) no se manda clave.
 */
export function idempotencyKey(ctx: IExecuteFunctions, itemIndex: number, operation: string): string | undefined {
	let execution = '';
	let node = '';
	let run = 0;
	try {
		execution = String(ctx.getExecutionId() ?? '');
		const n = ctx.getNode();
		node = String(n.id || n.name || '');
	} catch {
		return undefined;
	}
	try {
		run = Number(ctx.getWorkflowDataProxy(itemIndex).$thisRunIndex) || 0;
	} catch {
		run = 0;
	}
	if (!execution) return undefined;
	return `n8n-${execution}-${node}-${run}-${operation}-${itemIndex}`.slice(0, 190);
}

/** Adaptador para quicksend: request(method, path, { json, body, headers }). */
export function requester(ctx: IExecuteFunctions, itemIndex: number) {
	return async (method: string, path: string, o: { json?: unknown; body?: unknown; headers?: Record<string, string> } = {}) =>
		calaSignRequest<Record<string, unknown>>(ctx, method as IHttpRequestMethods, path, { body: (o.json ?? o.body) as IDataObject | Buffer | undefined, headers: o.headers }, itemIndex);
}

/** Verifica `CalaSign-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(secret, "<t>.<body>"), con 5 minutos de tolerancia. */
export function verifySignature(secret: string, header: string | undefined, rawBody: Buffer, now = Date.now()): boolean {
	if (!header) return false;
	const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
	const t = Number(parts.t);
	if (!parts.v1 || !Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
	const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
	const a = Buffer.from(expected);
	const b = Buffer.from(parts.v1);
	return a.length === b.length && timingSafeEqual(a, b);
}
