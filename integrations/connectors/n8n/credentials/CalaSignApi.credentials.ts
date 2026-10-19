import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class CalaSignApi implements ICredentialType {
	name = 'calaSignApi';

	displayName = 'CalaSign API';

	icon: Icon = { light: 'file:calasign.svg', dark: 'file:calasign.svg' };

	documentationUrl = '{{BASE_URL}}/developers/connectors#n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create it in CalaSign: Settings → API keys (starts with cs_live_ or cs_test_)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '{{BASE_URL}}',
			description: 'Change only for another CalaSign environment or your custom domain',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/me',
		},
	};
}
