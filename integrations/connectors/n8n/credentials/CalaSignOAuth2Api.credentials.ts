import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// OAuth 2.0 authorization code con PKCE S256 (CalaSign lo exige). Crear la app en CalaSign: Ajustes → Apps OAuth,
// redirect URI = la "OAuth Redirect URL" que muestra n8n.
export class CalaSignOAuth2Api implements ICredentialType {
	name = 'calaSignOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'CalaSign OAuth2 API';

	documentationUrl = '{{BASE_URL}}/developers/connectors#n8n';

	properties: INodeProperties[] = [
		{ displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'pkce' },
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '{{BASE_URL}}',
			description: 'Change only for another CalaSign environment or your custom domain',
		},
		{ displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: '={{$self["baseUrl"]}}/oauth/authorize' },
		{ displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: '={{$self["baseUrl"]}}/oauth/token' },
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'envelopes:read envelopes:write templates:read webhooks:manage offline_access',
		},
		{ displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'hidden', default: '' },
		{ displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'body' },
	];
}
