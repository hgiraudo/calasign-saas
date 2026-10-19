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
export type QuickSendRequest = (method: string, path: string, opts?: { json?: unknown; body?: unknown; headers?: Record<string, string> }) => Promise<Record<string, unknown>>;
export function quickSend(request: QuickSendRequest, input: QuickSendInput): Promise<Record<string, unknown>>;
export function flattenEvent(ev: Record<string, unknown>): Record<string, unknown>;
