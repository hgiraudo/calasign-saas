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
export async function calaSignRequest(
	ctx: Ctx,
	method: IHttpRequestMethods,
	path: string,
	opts: { body?: IDataObject | Buffer; qs?: IDataObject; headers?: IDataObject; binary?: boolean } = {},
	itemIndex = 0,
): Promise<any> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(ctx, itemIndex)}${path}`,
		headers: { 'User-Agent': 'CalaSign-n8n/{{VERSION}}', ...(opts.headers ?? {}) },
		qs: opts.qs,
		json: !Buffer.isBuffer(opts.body) && !opts.binary,
	};
	if (opts.body !== undefined) options.body = opts.body;
	if (opts.binary) options.encoding = 'arraybuffer';
	return ctx.helpers.httpRequestWithAuthentication.call(ctx, credentialType(ctx, itemIndex), options);
}

/** Adaptador para quicksend: request(method, path, { json, body, headers }). */
export function requester(ctx: IExecuteFunctions, itemIndex: number) {
	return async (method: string, path: string, o: { json?: IDataObject; body?: Buffer; headers?: IDataObject } = {}) =>
		calaSignRequest(ctx, method as IHttpRequestMethods, path, { body: o.json ?? o.body, headers: o.headers }, itemIndex);
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
