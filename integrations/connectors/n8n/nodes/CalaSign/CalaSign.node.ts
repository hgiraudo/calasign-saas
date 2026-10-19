import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { calaSignRequest, requester } from '../GenericFunctions';
import { quickSend } from '../quicksend';

const envelopeId = (op: string[]) => ({
	displayName: 'Envelope ID',
	name: 'envelopeId',
	type: 'string' as const,
	required: true,
	default: '',
	displayOptions: { show: { resource: ['envelope'], operation: op } },
});

export class CalaSign implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalaSign',
		name: 'calaSign',
		icon: 'file:calasign.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send documents and templates for e-signature with CalaSign',
		defaults: { name: 'CalaSign' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{ name: 'calaSignApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
			{ name: 'calaSignOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'API Key', value: 'apiKey' },
					{ name: 'OAuth2', value: 'oAuth2' },
				],
				default: 'apiKey',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Envelope', value: 'envelope' },
					{ name: 'Template', value: 'template' },
				],
				default: 'envelope',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['envelope'] } },
				options: [
					{ name: 'Download Signed PDF', value: 'downloadSigned', action: 'Download the signed PDF', description: 'Download the signed PDF of a completed envelope' },
					{ name: 'Get', value: 'get', action: 'Get an envelope', description: 'Get an envelope with its status and recipients' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many envelopes', description: 'List envelopes' },
					{ name: 'Remind', value: 'remind', action: 'Remind pending recipients', description: 'Send a reminder to pending recipients' },
					{ name: 'Send Document', value: 'sendDocument', action: 'Send a document for signature', description: 'Send a PDF from a binary property to one or more signers' },
					{ name: 'Send From Template', value: 'sendFromTemplate', action: 'Send an envelope from a template', description: 'Create and send an envelope from a template' },
					{ name: 'Void', value: 'void', action: 'Void an envelope', description: 'Cancel a sent envelope' },
				],
				default: 'sendFromTemplate',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['template'] } },
				options: [{ name: 'Get Many', value: 'getAll', action: 'Get many templates', description: 'List templates' }],
				default: 'getAll',
			},

			// ───── Enviar desde plantilla ─────
			{
				displayName: 'Template Name or ID',
				name: 'templateId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTemplates' },
				required: true,
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: { show: { resource: ['envelope'], operation: ['sendFromTemplate'] } },
			},
			{
				displayName: 'Recipients',
				name: 'roles',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Recipient',
				default: {},
				displayOptions: { show: { resource: ['envelope'], operation: ['sendFromTemplate'] } },
				options: [
					{
						name: 'role',
						displayName: 'Recipient',
						values: [
							{
								displayName: 'Role Name or ID',
								name: 'role',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getTemplateRoles', loadOptionsDependsOn: ['templateId'] },
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '' },
							{ displayName: 'Phone', name: 'phone', type: 'string', default: '', description: 'E.164 mobile number for WhatsApp, e.g. +18095551234' },
						],
					},
				],
			},
			{
				displayName: 'Prefilled Fields',
				name: 'prefill',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['envelope'], operation: ['sendFromTemplate'] } },
				options: [
					{
						name: 'field',
						displayName: 'Field',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getTemplateFields', loadOptionsDependsOn: ['templateId'] },
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},

			// ───── Enviar documento ─────
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary property with the PDF',
				displayOptions: { show: { resource: ['envelope'], operation: ['sendDocument'] } },
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['envelope'], operation: ['sendDocument'] } },
			},
			{
				displayName: 'Signers',
				name: 'signers',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Signer',
				default: {},
				displayOptions: { show: { resource: ['envelope'], operation: ['sendDocument'] } },
				options: [
					{
						name: 'signer',
						displayName: 'Signer',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '' },
							{ displayName: 'Phone', name: 'phone', type: 'string', default: '', description: 'E.164 mobile number for WhatsApp, e.g. +18095551234' },
						],
					},
				],
			},
			{
				displayName: 'Signature Placement',
				name: 'placement',
				type: 'options',
				options: [
					{ name: 'Last Page (Automatic)', value: 'auto' },
					{ name: 'Anchor Texts \\firma1\\, \\firma2\\…', value: 'anchors' },
				],
				default: 'auto',
				displayOptions: { show: { resource: ['envelope'], operation: ['sendDocument'] } },
			},

			// ───── Opciones comunes de envío ─────
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['envelope'], operation: ['sendFromTemplate', 'sendDocument'] } },
				options: [
					{ displayName: 'Subject', name: 'subject', type: 'string', default: '', description: 'Overrides the template subject' },
					{ displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 3 }, default: '' },
					{ displayName: 'External ID', name: 'externalId', type: 'string', default: '', description: 'Your own reference; comes back in every event as metadata.externalId' },
					{ displayName: 'Expires At', name: 'expiresAt', type: 'dateTime', default: '' },
					{ displayName: 'Sign In Order', name: 'sequential', type: 'boolean', default: false, description: 'Whether signers sign one after another (Send Document)' },
					{ displayName: 'Send Now', name: 'send', type: 'boolean', default: true, description: 'Whether to send now; otherwise a draft is created' },
				],
			},

			envelopeId(['get', 'downloadSigned', 'void', 'remind']),
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['envelope'], operation: ['void'] } },
			},
			{
				displayName: 'Put Output File in Field',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { resource: ['envelope'], operation: ['downloadSigned'] } },
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Any', value: '' },
					{ name: 'Completed', value: 'completed' },
					{ name: 'Declined', value: 'declined' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'Expired', value: 'expired' },
					{ name: 'Sent', value: 'sent' },
					{ name: 'Voided', value: 'voided' },
				],
				default: '',
				displayOptions: { show: { resource: ['envelope'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['envelope'], operation: ['getAll'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const res = await calaSignRequest(this, 'GET', '/v1/templates');
				return (res.items ?? []).map((t: IDataObject) => ({ name: String(t.name), value: String(t.id) }));
			},
			async getTemplateRoles(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const id = this.getCurrentNodeParameter('templateId') as string;
				if (!id) return [];
				const s = await calaSignRequest(this, 'GET', `/v1/templates/${encodeURIComponent(id)}/input-schema`);
				return (s.roles ?? []).map((r: IDataObject) => ({ name: String(r.name), value: String(r.id) }));
			},
			async getTemplateFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const id = this.getCurrentNodeParameter('templateId') as string;
				if (!id) return [];
				const s = await calaSignRequest(this, 'GET', `/v1/templates/${encodeURIComponent(id)}/input-schema`);
				return (s.fields ?? []).map((f: IDataObject) => ({ name: String(f.label ?? f.id), value: String(f.id), description: f.roleName ? `For ${f.roleName}` : undefined }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				if (resource === 'template') {
					const res = await calaSignRequest(this, 'GET', '/v1/templates', {}, i);
					for (const t of res.items ?? []) out.push({ json: t, pairedItem: { item: i } });
					continue;
				}
				const extra = (operation === 'sendFromTemplate' || operation === 'sendDocument' ? this.getNodeParameter('additionalFields', i, {}) : {}) as IDataObject;
				const metadata = extra.externalId ? { externalId: String(extra.externalId) } : undefined;
				if (operation === 'sendFromTemplate') {
					const templateId = this.getNodeParameter('templateId', i) as string;
					const roles: IDataObject = {};
					for (const r of ((this.getNodeParameter('roles', i, {}) as IDataObject).role as IDataObject[]) ?? []) {
						roles[String(r.role)] = { name: r.name, email: r.email || null, phone: r.phone || null };
					}
					const prefill: IDataObject = {};
					for (const f of ((this.getNodeParameter('prefill', i, {}) as IDataObject).field as IDataObject[]) ?? []) prefill[String(f.field)] = f.value;
					const body: IDataObject = { roles, prefill, send: extra.send !== false };
					if (extra.subject) body.subject = extra.subject;
					if (extra.message) body.message = extra.message;
					if (extra.expiresAt) body.expiresAt = new Date(String(extra.expiresAt)).toISOString();
					if (metadata) body.metadata = metadata;
					const res = await calaSignRequest(this, 'POST', `/v1/envelopes/from-template/${encodeURIComponent(templateId)}`, { body }, i);
					out.push({ json: res, pairedItem: { item: i } });
				} else if (operation === 'sendDocument') {
					const prop = this.getNodeParameter('binaryPropertyName', i) as string;
					const bin = this.helpers.assertBinaryData(i, prop);
					const bytes = await this.helpers.getBinaryDataBuffer(i, prop);
					const signers = ((this.getNodeParameter('signers', i, {}) as IDataObject).signer as IDataObject[]) ?? [];
					const res = await quickSend(requester(this, i), {
						subject: this.getNodeParameter('subject', i) as string,
						message: extra.message as string | undefined,
						fileName: bin.fileName ?? 'documento.pdf',
						fileBytes: bytes,
						signers: signers.map((s) => ({ name: String(s.name ?? ''), email: s.email ? String(s.email) : undefined, phone: s.phone ? String(s.phone) : undefined })),
						placement: this.getNodeParameter('placement', i) as 'auto' | 'anchors',
						sequential: extra.sequential === true,
						send: extra.send !== false,
						expiresAt: extra.expiresAt ? new Date(String(extra.expiresAt)).toISOString() : undefined,
						metadata,
					});
					out.push({ json: res, pairedItem: { item: i } });
				} else if (operation === 'get') {
					const id = encodeURIComponent(this.getNodeParameter('envelopeId', i) as string);
					out.push({ json: await calaSignRequest(this, 'GET', `/v1/envelopes/${id}`, {}, i), pairedItem: { item: i } });
				} else if (operation === 'getAll') {
					const status = this.getNodeParameter('status', i) as string;
					const limit = this.getNodeParameter('limit', i) as number;
					const res = await calaSignRequest(this, 'GET', '/v1/envelopes', { qs: { limit, ...(status ? { status } : {}) } }, i);
					for (const e of res.items ?? []) out.push({ json: e, pairedItem: { item: i } });
				} else if (operation === 'downloadSigned') {
					const raw = this.getNodeParameter('envelopeId', i) as string;
					const data = await calaSignRequest(this, 'GET', `/v1/envelopes/${encodeURIComponent(raw)}/signed.pdf`, { binary: true }, i);
					const prop = this.getNodeParameter('outputBinaryPropertyName', i) as string;
					const binary = await this.helpers.prepareBinaryData(Buffer.from(data as ArrayBuffer), `calasign-${raw}.pdf`, 'application/pdf');
					out.push({ json: { envelopeId: raw }, binary: { [prop]: binary }, pairedItem: { item: i } });
				} else if (operation === 'void') {
					const id = encodeURIComponent(this.getNodeParameter('envelopeId', i) as string);
					const res = await calaSignRequest(this, 'POST', `/v1/envelopes/${id}/void`, { body: { reason: this.getNodeParameter('reason', i) as string } }, i);
					out.push({ json: res, pairedItem: { item: i } });
				} else if (operation === 'remind') {
					const id = encodeURIComponent(this.getNodeParameter('envelopeId', i) as string);
					out.push({ json: await calaSignRequest(this, 'POST', `/v1/envelopes/${id}/remind`, { body: {} }, i), pairedItem: { item: i } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, { itemIndex: i });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}
		return [out];
	}
}
