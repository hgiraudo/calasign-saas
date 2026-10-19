// Tipos de integrations/connectors/_lib/quicksend.cjs (el build lo empaqueta en cada nodo).
export interface QuickSendSigner {
	name: string;
	email?: string;
	phone?: string;
	role?: string;
	routingOrder?: number;
}
export interface QuickSendInput {
	subject?: string;
	message?: string;
	fileName?: string;
	fileBytes: Uint8Array;
	signers: QuickSendSigner[];
	placement?: 'auto' | 'anchors';
	sequential?: boolean;
	send?: boolean;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
}
export function quickSend(request: (method: string, path: string, opts?: any) => Promise<any>, input: QuickSendInput): Promise<any>;
export function flattenEvent(ev: any): Record<string, any>;
