import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http';
import {randomBytes, timingSafeEqual} from 'crypto';

export interface TokenBridgePayload {
	token: string;
	expiresAt?: number;
}

export interface TokenBridgeServerOptions {
	port: number;
	secret: string;
	onToken: (payload: TokenBridgePayload) => Promise<void>;
	onLog?: (message: string) => void;
}

export interface TokenBridgeServer {
	start(): Promise<void>;
	stop(): Promise<void>;
}

const MAX_BODY_BYTES = 8192;

class BodyTooLargeError extends Error {}

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		return false;
	}

	return timingSafeEqual(bufA, bufB);
}

export function generateBridgeSecret(): string {
	return randomBytes(24).toString('hex');
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		let tooLarge = false;
		const chunks: Buffer[] = [];

		req.on('data', (chunk: Buffer) => {
			if (tooLarge) {
				return;
			}

			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				tooLarge = true;
				reject(new BodyTooLargeError('Request body too large.'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!tooLarge) {
				resolve(Buffer.concat(chunks).toString('utf8'));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

function sendJsonAndClose(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.setHeader('Connection', 'close');
	res.on('finish', () => req.destroy());
	sendJson(res, status, body);
}

export function createTokenBridgeServer(options: TokenBridgeServerOptions): TokenBridgeServer {
	let server: Server | null = null;

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== 'POST' || req.url !== '/token') {
			sendJson(res, 404, {error: 'not_found'});
			return;
		}

		const providedSecret = req.headers['x-bridge-secret'];
		if (typeof providedSecret !== 'string' || !safeEqual(providedSecret, options.secret)) {
			sendJson(res, 401, {error: 'invalid_secret'});
			return;
		}

		try {
			const rawBody = await readBody(req);
			const parsed = JSON.parse(rawBody) as unknown;
			if (typeof parsed !== 'object' || parsed === null) {
				sendJson(res, 400, {error: 'invalid_body'});
				return;
			}

			const record = parsed as Record<string, unknown>;
			const token = typeof record.token === 'string' ? record.token.trim() : '';
			if (!token) {
				sendJson(res, 400, {error: 'missing_token'});
				return;
			}

			const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
				? record.expiresAt
				: undefined;

			await options.onToken({token, expiresAt});
			sendJson(res, 200, {status: 'ok'});
		} catch (error) {
			if (error instanceof BodyTooLargeError) {
				options.onLog?.('bridge request rejected: payload too large');
				sendJsonAndClose(req, res, 413, {error: 'payload_too_large'});
				return;
			}

			options.onLog?.(`bridge request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
			sendJson(res, 400, {error: 'bad_request'});
		}
	}

	return {
		start(): Promise<void> {
			return new Promise((resolve, reject) => {
				const instance = createServer((req, res) => {
					void handleRequest(req, res);
				});

				const onError = (error: Error): void => {
					instance.removeAllListeners();
					reject(error);
				};

				instance.once('error', onError);
				instance.listen(options.port, '127.0.0.1', () => {
					instance.removeListener('error', onError);
					instance.on('error', (error) => {
						options.onLog?.(`token bridge server error: ${error.message}`);
					});
					server = instance;
					resolve();
				});
			});
		},
		stop(): Promise<void> {
			return new Promise((resolve) => {
				if (!server) {
					resolve();
					return;
				}

				const instance = server;
				server = null;
				instance.close(() => resolve());
			});
		}
	};
}
