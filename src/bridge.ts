// Browser bridge: pi runs a WebSocket server on 127.0.0.1, the Chrome
// extension dials in (MV3 extensions cannot listen). One connection per pi
// process; the extension scans the port range and keeps a connection to
// every live server.
//
// Lifecycle is session-scoped, not module-scoped: /reload makes pi re-import
// the extension module (clearExtensionCache + jiti moduleCache:false), so a
// server left running by an old module instance would leak its port. Start in
// session_start, close in session_shutdown.

import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { SearchResult } from "./search.ts";

export const BRIDGE_PORT_MIN = 17890;
export const BRIDGE_PORT_MAX = 17899;

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 5_000;
// 20s, not 30s: an MV3 service worker is killed after 30s idle and only
// JS-visible WebSocket traffic reliably resets that timer.
const PING_INTERVAL_MS = 20_000;
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;

export type BridgeFetchPage = { url: string; text: string };
export type BridgeFetchResult = {
	pages: BridgeFetchPage[];
	failures: string[];
};

type Pending = {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | undefined;
};

let server: WebSocketServer | null = null;
let bridge: WebSocket | null = null;
let conversationId: string | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let startPromise: Promise<WebSocketServer> | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function rejectAllPending(reason: string) {
	for (const [, p] of pending) {
		clearTimeout(p.timer);
		p.reject(new Error(reason));
	}
	pending.clear();
}

function failHello(ws: WebSocket, error: string) {
	try {
		ws.send(JSON.stringify({ type: "helloAck", ok: false, error }));
	} catch {
		// peer already gone; close() below still runs
	}
	ws.close(4000, error);
}

function handleConnection(ws: WebSocket) {
	const helloTimer = setTimeout(
		() => ws.close(4000, "hello timeout"),
		HELLO_TIMEOUT_MS,
	);

	ws.on("message", (data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.type === "hello") {
			clearTimeout(helloTimer);
			if (bridge) {
				failHello(ws, "connection already established");
				return;
			}
			if (msg.protocol !== PROTOCOL_VERSION) {
				failHello(ws, `unsupported protocol: ${String(msg.protocol)}`);
				return;
			}
			bridge = ws;
			ws.send(
				JSON.stringify({
					type: "helloAck",
					ok: true,
					protocol: PROTOCOL_VERSION,
				}),
			);
			return;
		}
		if (msg.type === "response" && ws === bridge) {
			const p = pending.get(msg.id as number);
			if (!p) return;
			pending.delete(msg.id as number);
			clearTimeout(p.timer);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(String(msg.error ?? "bridge error")));
		}
	});

	ws.on("close", () => {
		clearTimeout(helloTimer);
		if (ws === bridge) {
			bridge = null;
			rejectAllPending("bridge disconnected");
		}
	});
	// 'error' always precedes 'close' on ws; swallow so an abrupt extension
	// kill doesn't become an unhandled 'error' event crash.
	ws.on("error", () => {});
}

async function bindFirstFreePort(): Promise<WebSocketServer> {
	let lastError: unknown;
	for (let port = BRIDGE_PORT_MIN; port <= BRIDGE_PORT_MAX; port++) {
		const wss = new WebSocketServer({ host: "127.0.0.1", port });
		try {
			await new Promise<void>((resolve, reject) => {
				wss.once("listening", resolve);
				wss.once("error", reject);
			});
			return wss;
		} catch (err) {
			lastError = err;
			wss.close();
		}
	}
	throw new Error(
		`No free bridge port in ${BRIDGE_PORT_MIN}-${BRIDGE_PORT_MAX}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

/** Idempotent: a running server is reused; conversationId always updated.
 *  Returns the bound port. */
export async function startBridge(id: string): Promise<number> {
	conversationId = id;
	if (server) return (server.address() as AddressInfo).port;
	startPromise ??= (async () => {
		const wss = await bindFirstFreePort();
		wss.on("connection", handleConnection);
		wss.on("error", () => {});
		// Application-level heartbeat: the MV3 service worker is killed after
		// 30s idle and only JS-visible WebSocket traffic reliably resets that
		// timer. A protocol-level ping/pong dead-peer detector is pointless on
		// loopback — a dead peer's kernel always closes the socket.
		pingTimer = setInterval(() => {
			const ws = bridge;
			if (!ws) return;
			try {
				ws.send(JSON.stringify({ type: "ping" }));
			} catch {
				// closing concurrently; the close handler cleans up
			}
		}, PING_INTERVAL_MS);
		pingTimer.unref();
		server = wss;
		return wss;
	})();
	let wss: WebSocketServer;
	try {
		wss = await startPromise;
	} finally {
		startPromise = null;
	}
	return (wss.address() as AddressInfo).port;
}

export async function stopBridge(): Promise<void> {
	if (startPromise) await startPromise.catch(() => {});
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
	rejectAllPending("bridge stopped");
	const ws = bridge;
	bridge = null;
	ws?.close(1000, "session shutdown");
	const wss = server;
	server = null;
	if (wss) {
		await new Promise<void>((resolve) => wss.close(() => resolve()));
	}
}

export function isBridgeConnected(): boolean {
	return bridge !== null && bridge.readyState === WebSocket.OPEN;
}

function request(
	kind: string,
	params: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	const ws = bridge;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		return Promise.reject(new Error("browser bridge not connected"));
	}
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		// All settle paths go through entry.resolve/entry.reject so the abort
		// listener is always removed — including the timeout path.
		const entry: Pending = {
			resolve: (r) => {
				signal?.removeEventListener("abort", onAbort);
				clearTimeout(entry.timer);
				resolve(r);
			},
			reject: (e) => {
				signal?.removeEventListener("abort", onAbort);
				clearTimeout(entry.timer);
				reject(e);
			},
			timer: undefined,
		};
		const onAbort = () => {
			if (pending.delete(id)) {
				entry.reject(
					signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
				);
			}
		};
		entry.timer = setTimeout(() => {
			if (pending.delete(id)) {
				entry.reject(
					new Error(`bridge ${kind} timed out after ${timeoutMs}ms`),
				);
			}
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		pending.set(id, entry);
		ws.send(
			JSON.stringify({ type: "request", id, kind, conversationId, params }),
		);
	});
}

export async function bridgeSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const result = (await request(
		"search",
		{ query, maxResults },
		SEARCH_TIMEOUT_MS,
		signal,
	)) as { results?: SearchResult[] };
	if (!Array.isArray(result?.results) || result.results.length === 0) {
		throw new Error("bridge search returned no results");
	}
	return result.results;
}

export async function bridgeFetch(
	urls: string[],
	signal?: AbortSignal,
	question?: string,
): Promise<BridgeFetchResult> {
	const result = (await request(
		"fetch",
		{ urls, ...(question ? { question } : {}) },
		FETCH_TIMEOUT_MS,
		signal,
	)) as BridgeFetchResult | undefined;
	if (!result || !Array.isArray(result.pages)) {
		throw new Error("bridge fetch returned malformed result");
	}
	return { pages: result.pages, failures: result.failures ?? [] };
}

/** Fire-and-forget: the extension may already be gone during shutdown. */
export function notifyCloseSession(): void {
	if (!bridge || bridge.readyState !== WebSocket.OPEN || !conversationId) return;
	try {
		bridge.send(
			JSON.stringify({
				type: "notify",
				kind: "closeSession",
				conversationId,
			}),
		);
	} catch {
		// fire-and-forget: a dead socket must not break session shutdown
	}
}
