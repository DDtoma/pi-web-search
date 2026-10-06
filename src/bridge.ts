// Browser bridge facade. Every pi process shares ONE hub on
// 127.0.0.1:17890 (see hub.ts): the first process to bind the port becomes
// the hub, the rest connect as clients; when the hub process exits, a
// disconnected client rebinds and takes over. Client connections cost no
// port, so any number of pi sessions (including subagents) can coexist —
// the old 10-port ceiling is gone.
//
// Lifecycle is session-scoped, not module-scoped: /reload makes pi re-import
// the extension module (clearExtensionCache + jiti moduleCache:false), so a
// link owned by an old module instance would leak. Link in session_start,
// release in session_shutdown.

import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	HUB_PORT,
	HUB_PROTOCOL,
	EXT_REQUIRED_MSG,
	TOKEN_PATH,
	startHub,
	stopHub,
	hubHasExtension,
	hubSetSelfSession,
	hubSendRequest,
	hubNotifyCloseSession,
} from "./hub.ts";
import type { SearchResult } from "./search.ts";

/** Shared by web_search/web_fetch when the extension is not connected. */
export const BRIDGE_REQUIRED_MSG = EXT_REQUIRED_MSG;

const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const LINK_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

export type BridgeFetchPage = {
	url: string;
	text: string;
	/** True when the extension replaced page text with its own LLM summary. */
	summarized?: boolean;
};
export type BridgeFetchResult = {
	pages: BridgeFetchPage[];
	failures: string[];
};

type Pending = {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | undefined;
};

let conversationId: string | null = null;
let project: string | null = null;
let role: "hub" | "client" | null = null;
let clientWs: WebSocket | null = null;
let linking: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
// The popup's release button makes the hub drop this client; it must NOT
// auto-reconnect (that would undo the reclaim within seconds) — it re-links
// lazily when a real request needs the bridge.
let releasedByHub = false;
// Set by stopBridge: session_shutdown must disarm the reconnect loop for
// good — a close event firing after stop would otherwise re-arm it and the
// stale module instance would re-register (or worse, bind the port and
// become a zombie hub) after /reload.
let stopped = false;
// Last link failure, surfaced by ensureConnected instead of the generic
// BRIDGE_REQUIRED_MSG — a bad/stale token or a broken bind is otherwise
// indistinguishable from "extension not connected".
let lastLinkError: Error | null = null;
let nextClientRid = 1;
const pending = new Map<number, Pending>();

function rejectAllPending(reason: string) {
	for (const [, p] of pending) {
		clearTimeout(p.timer);
		p.reject(new Error(reason));
	}
	pending.clear();
}

function scheduleReconnect() {
	if (reconnectTimer || releasedByHub || stopped) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		void ensureLink();
	}, RECONNECT_DELAY_MS);
	reconnectTimer.unref();
}

function connectClient(): Promise<void> {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (!done) {
				done = true;
				fn();
			}
		};
		const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}`);
		const timer = setTimeout(() => ws.close(), LINK_TIMEOUT_MS);
		ws.on("open", () => {
			// Read at dial time, not module load: a hub restart rotates the
			// token, and the reconnect loop must pick up the new one.
			let token = "";
			try {
				token = readFileSync(TOKEN_PATH, "utf8").trim();
			} catch {
				// No token file: the hub predates token auth or hasn't written
				// yet — register anyway and let the hub decide.
			}
			ws.send(
				JSON.stringify({
					type: "register",
					protocol: HUB_PROTOCOL,
					conversationId,
					project,
					token,
				}),
			);
		});
		ws.on("message", (data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.type === "registerAck") {
				clearTimeout(timer);
				if (msg.ok) {
					role = "client";
					clientWs = ws;
					finish(resolve);
				} else {
					ws.close();
					finish(() => reject(new Error(String(msg.error ?? "register rejected"))));
				}
				return;
			}
			if (msg.type === "response") {
				const p = pending.get(msg.rid as number);
				if (!p) return;
				pending.delete(msg.rid as number);
				clearTimeout(p.timer);
				if (msg.ok) p.resolve(msg.result);
				else p.reject(new Error(String(msg.error ?? "bridge error")));
				return;
			}
			if (msg.type === "released") {
				releasedByHub = true;
				ws.close();
			}
		});
		ws.on("close", () => {
			clearTimeout(timer);
			if (clientWs === ws) {
				clientWs = null;
				role = null;
			}
			rejectAllPending("bridge disconnected");
			finish(() => reject(new Error("bridge link closed")));
			scheduleReconnect();
		});
		// 'error' always precedes 'close' on ws; swallow so a failed dial
		// doesn't crash as an unhandled 'error' event.
		ws.on("error", () => {});
	});
}

/** Become the hub, or register with whoever holds the port. Never throws
 *  for ordinary link failures — the reconnect loop keeps retrying. */
function ensureLink(): Promise<void> {
	if (role) return Promise.resolve();
	linking ??= (async () => {
		releasedByHub = false;
		try {
			await startHub();
			role = "hub";
			hubSetSelfSession({ conversationId, project });
			lastLinkError = null;
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code && code !== "EADDRINUSE") {
				// Not a port conflict (e.g. the token write failed): nothing
				// is listening, so dialing is pointless. Record the cause and
				// let the reconnect loop retry.
				lastLinkError = err instanceof Error ? err : new Error(String(err));
				scheduleReconnect();
				return;
			}
			// Port taken: another pi process is the hub. Fall through to
			// client mode.
		}
		try {
			await connectClient();
			lastLinkError = null;
		} catch (err) {
			lastLinkError = err instanceof Error ? err : new Error(String(err));
			scheduleReconnect();
		}
	})().finally(() => {
		linking = null;
	});
	return linking;
}

async function ensureConnected(): Promise<void> {
	if (role === "hub") return;
	if (role === "client" && clientWs?.readyState === WebSocket.OPEN) return;
	await ensureLink();
	// ensureLink mutates role asynchronously; re-read through a widening
	// cast or TS's narrowing (stale across await) rejects the comparison.
	const linked: string | null = role;
	if (linked === "hub") return;
	if (role === "client" && clientWs?.readyState === WebSocket.OPEN) return;
	throw lastLinkError ?? new Error(BRIDGE_REQUIRED_MSG);
}

/** Idempotent: an established link is reused; conversationId always updated.
 *  Returns the hub port. */
export async function startBridge(id: string): Promise<number> {
	conversationId = id;
	project = basename(process.cwd());
	stopped = false;
	if (role === "hub") {
		hubSetSelfSession({ conversationId, project });
		return HUB_PORT;
	}
	await ensureLink();
	// Already linked as a client (pi's /new started a fresh session in the
	// same process): re-register so the hub lists the new conversationId.
	if (role === "client" && clientWs?.readyState === WebSocket.OPEN) {
		try {
			clientWs.send(
				JSON.stringify({
					type: "register",
					protocol: HUB_PROTOCOL,
					conversationId,
					project,
					token: readFileSync(TOKEN_PATH, "utf8").trim(),
				}),
			);
		} catch {
			// closing concurrently; the close handler schedules a relink
		}
	}
	return HUB_PORT;
}

export async function stopBridge(): Promise<void> {
	stopped = true;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (linking) await linking.catch(() => {});
	rejectAllPending("bridge stopped");
	const ws = clientWs;
	clientWs = null;
	ws?.close(1000, "session shutdown");
	if (role === "hub") {
		hubSetSelfSession(null);
		await stopHub();
	}
	role = null;
}

export function isBridgeConnected(): boolean {
	if (role === "hub") return hubHasExtension();
	return clientWs !== null && clientWs.readyState === WebSocket.OPEN;
}

/** Current link role — exposed for the smoke scripts (takeover test). */
export function bridgeRole(): "hub" | "client" | null {
	return role;
}

async function request(
	kind: string,
	params: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	await ensureConnected();
	// ensureConnected awaits the link; an abort that landed during that
	// window never fires the listener attached below, so check explicitly.
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
	}
	if (role === "hub") {
		return hubSendRequest(kind, conversationId, params, timeoutMs, signal);
	}
	const ws = clientWs;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		throw new Error(BRIDGE_REQUIRED_MSG);
	}
	const rid = nextClientRid++;
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
			if (pending.delete(rid)) {
				entry.reject(
					signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
				);
			}
		};
		entry.timer = setTimeout(() => {
			if (pending.delete(rid)) {
				entry.reject(new Error(`bridge ${kind} timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		pending.set(rid, entry);
		ws.send(JSON.stringify({ type: "request", rid, kind, conversationId, params }));
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

export type BridgeSnapshot = { url: string; title: string; snapshot: string };
export type BridgeSnapshotResult = {
	snapshots: BridgeSnapshot[];
	failures: string[];
};

export async function bridgeSnapshot(
	urls: string[],
	maxChars: number,
	signal?: AbortSignal,
): Promise<BridgeSnapshotResult> {
	const result = (await request(
		"snapshot",
		{ urls, maxChars },
		FETCH_TIMEOUT_MS,
		signal,
	)) as BridgeSnapshotResult | undefined;
	if (
		!result ||
		!Array.isArray(result.snapshots) ||
		result.snapshots.some(
			(s) =>
				typeof s?.url !== "string" ||
				typeof s?.title !== "string" ||
				typeof s?.snapshot !== "string",
		)
	) {
		throw new Error("bridge snapshot returned malformed result");
	}
	return { snapshots: result.snapshots, failures: result.failures ?? [] };
}

/** Run JS in the tab already showing `url`. Returns the expression value. */
export async function bridgeEval(
	url: string,
	code: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const result = (await request(
		"eval",
		{ url, code },
		FETCH_TIMEOUT_MS,
		signal,
	)) as { result?: unknown } | undefined;
	return result?.result;
}

/** Close this session's tab group. False when the group is already gone. */
export async function bridgeCloseGroup(signal?: AbortSignal): Promise<boolean> {
	const result = (await request(
		"closeGroup",
		{},
		SEARCH_TIMEOUT_MS,
		signal,
	)) as { closed?: boolean } | undefined;
	return result?.closed === true;
}

/** Fire-and-forget: the extension may already be gone during shutdown. */
export function notifyCloseSession(): void {
	if (!conversationId) return;
	if (role === "hub") {
		hubNotifyCloseSession(conversationId);
		return;
	}
	if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
	try {
		clientWs.send(
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
