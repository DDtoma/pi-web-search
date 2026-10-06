// Bridge hub: ONE WebSocket server on 127.0.0.1:17890 shared by every pi
// process (clients) and the Chrome extension (one slot). The pi process
// that binds the port becomes the hub; when it exits, a disconnected
// client rebinds and takes over (see bridge.ts). This replaces the old
// one-port-per-pi design that capped the machine at 10 sessions.
//
// Routing: client request → hub → extension → hub → client. The hub's own
// pi session short-circuits straight to the extension connection.

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const HUB_PORT = 17890;
export const HUB_PROTOCOL = 2;
const EXT_PING_INTERVAL_MS = 20_000;
// Longest client-side timeout (fetch, 60s) plus slack: routed entries
// outlive the request that created them at most by this much.
const ROUTE_TTL_MS = 90_000;
// Clients authenticate with this token (the extension authenticates via
// its chrome-extension:// Origin instead — a socket has no file access).
// 0600 under the user's home: stops other local users, not same-user
// malware, which can read the file. Env override exists so smoke runs
// (netns isolates the port, not $HOME) never clobber a live hub's token.
// An exported-but-empty or relative override would break the token write
// ("" → ENOENT) or split hub/client paths (relative resolves against each
// process's own cwd) — normalize both away.
const envTokenPath = process.env.WEB_SEARCH_HUB_TOKEN_PATH?.trim();
export const TOKEN_PATH = envTokenPath
	? resolve(envTokenPath)
	: join(homedir(), ".pi", "agent", "web-search-hub-token");
export const EXT_REQUIRED_MSG =
	"Chrome extension not connected to the bridge hub. Load extension/ in chrome://extensions.";

type Client = {
	ws: WebSocket;
	conversationId: string | null;
	project: string | null;
};

type Pending = {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

let wss: WebSocketServer | null = null;
let ext: WebSocket | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let authToken: string | null = null;
let nextClientId = 1;
const clients = new Map<number, Client>();
let selfSession: { conversationId: string | null; project: string | null } | null =
	null;
let nextRouteId = 1;
/** hubRid → client awaiting the extension's response */
const routes = new Map<number, { clientId: number; rid: number; deadline: number }>();
/** hubRid → promise of the hub process's own request */
const selfPending = new Map<number, Pending>();

function sessionsPayload() {
	const list = [...clients.entries()].map(([clientId, c]) => ({
		clientId,
		conversationId: c.conversationId,
		project: c.project,
		self: false,
	}));
	if (selfSession) list.unshift({ clientId: 0, ...selfSession, self: true });
	return list;
}

function pushSessions() {
	if (ext?.readyState === WebSocket.OPEN) {
		ext.send(JSON.stringify({ type: "sessions", sessions: sessionsPayload() }));
	}
}

function releaseClient(clientId: number) {
	// clientId 0 is the hub's own session: releasing it would free nothing
	// (this process owns the port either way), so the popup hides it.
	const client = clients.get(clientId);
	if (!client) return;
	clients.delete(clientId);
	try {
		client.ws.send(JSON.stringify({ type: "released" }));
	} catch {
		// socket already closing
	}
	client.ws.close(4001, "released");
	pushSessions();
}

function failRoutes(error: string) {
	for (const [hubRid, route] of routes) {
		clients
			.get(route.clientId)
			?.ws.send(JSON.stringify({ type: "response", rid: route.rid, ok: false, error }));
		routes.delete(hubRid);
	}
}

function handleExtMessage(msg: Record<string, unknown>) {
	if (msg.type === "response") {
		const rid = msg.rid as number;
		const self = selfPending.get(rid);
		if (self) {
			selfPending.delete(rid);
			clearTimeout(self.timer);
			if (msg.ok) self.resolve(msg.result);
			else self.reject(new Error(String(msg.error ?? "bridge error")));
			return;
		}
		const route = routes.get(rid);
		if (!route) return;
		routes.delete(rid);
		clients.get(route.clientId)?.ws.send(
			JSON.stringify({
				type: "response",
				rid: route.rid,
				ok: msg.ok,
				...(msg.ok ? { result: msg.result } : { error: msg.error }),
			}),
		);
		return;
	}
	if (msg.type === "release") {
		releaseClient(msg.clientId as number);
	}
}

function handleClientMessage(
	clientId: number,
	ws: WebSocket,
	msg: Record<string, unknown>,
) {
	// A second register from an already-registered client is a session
	// update: pi's /new ends one conversation and starts another in the
	// same process, and the popup must not keep listing the stale id.
	if (msg.type === "register") {
		const client = clients.get(clientId);
		if (client) {
			client.conversationId = (msg.conversationId as string) ?? null;
			client.project = (msg.project as string) ?? null;
			ws.send(JSON.stringify({ type: "registerAck", ok: true, clientId }));
			pushSessions();
		}
		return;
	}
	if (msg.type === "request") {
		if (!ext || ext.readyState !== WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					type: "response",
					rid: msg.rid,
					ok: false,
					error: EXT_REQUIRED_MSG,
				}),
			);
			return;
		}
		const hubRid = nextRouteId++;
		routes.set(hubRid, {
			clientId,
			rid: msg.rid as number,
			deadline: Date.now() + ROUTE_TTL_MS,
		});
		ext.send(
			JSON.stringify({
				type: "request",
				rid: hubRid,
				kind: msg.kind,
				// The registered identity is authoritative: a client must not
				// drive (or close) another session's tab group by claiming its
				// conversationId.
				conversationId: clients.get(clientId)?.conversationId ?? null,
				params: msg.params,
			}),
		);
		return;
	}
	if (msg.type === "notify") {
		// closeSession etc.: forwarded with the registered conversationId
		// (see request above); the extension keys groups by conversationId.
		if (ext?.readyState === WebSocket.OPEN) {
			ext.send(
				JSON.stringify({
					...msg,
					conversationId: clients.get(clientId)?.conversationId ?? null,
				}),
			);
		}
	}
}

function handleConnection(ws: WebSocket, req: IncomingMessage) {
	// Browsers always send Origin: web pages send http(s)://..., the
	// extension sends chrome-extension://<id>. pi clients (node ws) send
	// none. A web page must never become a client (forged search results)
	// nor the extension (result exfiltration).
	const origin = req.headers.origin;
	const isExtensionOrigin = origin?.startsWith("chrome-extension://") ?? false;
	if (origin && !isExtensionOrigin) {
		ws.close(4000, "origin not allowed");
		return;
	}
	let role: "ext" | "client" | null = null;
	let clientId: number | null = null;
	const helloTimer = setTimeout(() => ws.close(4000, "hello timeout"), 5000);

	ws.on("message", (data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (!role) {
			clearTimeout(helloTimer);
			if (msg.type === "extHello") {
				if (!isExtensionOrigin) {
					ws.close(4000, "extHello requires a chrome-extension origin");
					return;
				}
				if (msg.protocol !== HUB_PROTOCOL) {
					ws.send(
						JSON.stringify({
							type: "extHelloAck",
							ok: false,
							error: `unsupported protocol: ${String(msg.protocol)}`,
						}),
					);
					ws.close(4000, "unsupported protocol");
					return;
				}
				if (ext) {
					ws.send(
						JSON.stringify({
							type: "extHelloAck",
							ok: false,
							error: "extension already connected",
						}),
					);
					ws.close(4000, "extension already connected");
					return;
				}
				ext = ws;
				role = "ext";
				ws.send(
					JSON.stringify({
						type: "extHelloAck",
						ok: true,
						protocol: HUB_PROTOCOL,
						sessions: sessionsPayload(),
					}),
				);
				return;
			}
			if (msg.type === "register") {
				if (isExtensionOrigin) {
					ws.close(4000, "extension origin cannot register as a client");
					return;
				}
				if (msg.protocol !== HUB_PROTOCOL) {
					ws.send(
						JSON.stringify({
							type: "registerAck",
							ok: false,
							error: `unsupported protocol: ${String(msg.protocol)}`,
						}),
					);
					ws.close(4000, "unsupported protocol");
					return;
				}
				if (msg.token !== authToken) {
					ws.send(
						JSON.stringify({
							type: "registerAck",
							ok: false,
							error: "unauthorized: bad or missing token",
						}),
					);
					ws.close(4000, "unauthorized");
					return;
				}
				clientId = nextClientId++;
				clients.set(clientId, {
					ws,
					conversationId: (msg.conversationId as string) ?? null,
					project: (msg.project as string) ?? null,
				});
				role = "client";
				ws.send(JSON.stringify({ type: "registerAck", ok: true, clientId }));
				pushSessions();
				return;
			}
			ws.close(4000, "first message must be extHello or register");
			return;
		}
		if (role === "ext") handleExtMessage(msg);
		else if (clientId != null) handleClientMessage(clientId, ws, msg);
	});

	ws.on("close", () => {
		clearTimeout(helloTimer);
		if (role === "ext" && ext === ws) {
			ext = null;
			for (const [, p] of selfPending) {
				clearTimeout(p.timer);
				p.reject(new Error("extension disconnected"));
			}
			selfPending.clear();
			failRoutes("extension disconnected");
			return;
		}
		if (role === "client" && clientId != null) {
			clients.delete(clientId);
			for (const [hubRid, route] of routes) {
				if (route.clientId === clientId) routes.delete(hubRid);
			}
			pushSessions();
		}
	});
	// 'error' always precedes 'close' on ws; swallow so an abrupt peer kill
	// doesn't become an unhandled 'error' event crash.
	ws.on("error", () => {});
}

/** Throws when the port is taken — the caller then connects as a client. */
export async function startHub(): Promise<void> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: HUB_PORT });
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("connection", (ws, req) => handleConnection(ws, req));
	server.on("error", () => {});
	wss = server;
	try {
		authToken = randomBytes(24).toString("hex");
		mkdirSync(dirname(TOKEN_PATH), { recursive: true });
		writeFileSync(TOKEN_PATH, authToken, { mode: 0o600 });
	} catch (err) {
		// Token write failed (ENOSPC/EACCES/EROFS): release the port before
		// rethrowing, or ensureLink mistakes this for "port taken", dials
		// our own server, and loops forever with the port held.
		await stopHub();
		throw err;
	}
	// The MV3 service worker dies after 30s idle; only JS-visible WebSocket
	// traffic reliably resets that timer.
	pingTimer = setInterval(() => {
		if (ext?.readyState === WebSocket.OPEN) {
			try {
				ext.send(JSON.stringify({ type: "ping" }));
			} catch {
				// closing concurrently; the close handler cleans up
			}
		}
		// Clients drop their own pending entry on timeout/abort without
		// telling the hub; sweep routes the client can no longer consume.
		const now = Date.now();
		for (const [hubRid, route] of routes) {
			if (route.deadline <= now) routes.delete(hubRid);
		}
	}, EXT_PING_INTERVAL_MS);
	pingTimer.unref();
}

export async function stopHub(): Promise<void> {
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
	for (const [, p] of selfPending) {
		clearTimeout(p.timer);
		p.reject(new Error("hub stopped"));
	}
	selfPending.clear();
	failRoutes("hub stopped");
	ext?.close(1000, "hub shutdown");
	ext = null;
	for (const [, c] of clients) c.ws.close(1000, "hub shutdown");
	clients.clear();
	selfSession = null;
	const server = wss;
	wss = null;
	if (server) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

export function hubHasExtension(): boolean {
	return ext !== null && ext.readyState === WebSocket.OPEN;
}

/** The hub process's own pi session, listed in the popup as clientId 0. */
export function hubSetSelfSession(session: {
	conversationId: string | null;
	project: string | null;
} | null): void {
	selfSession = session;
	pushSessions();
}

/** The hub process's own request: short-circuit to the extension. */
export function hubSendRequest(
	kind: string,
	conversationId: string | null,
	params: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	const ws = ext;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		return Promise.reject(new Error(EXT_REQUIRED_MSG));
	}
	const rid = nextRouteId++;
	return new Promise((resolve, reject) => {
		const entry: Pending = {
			resolve: (r) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			},
			reject: (e) => {
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			},
			timer: setTimeout(() => {
				if (selfPending.delete(rid)) {
					entry.reject(new Error(`bridge ${kind} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs),
		};
		const onAbort = () => {
			if (selfPending.delete(rid)) {
				clearTimeout(entry.timer);
				entry.reject(
					signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
				);
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		selfPending.set(rid, entry);
		ws.send(
			JSON.stringify({ type: "request", rid, kind, conversationId, params }),
		);
	});
}

export function hubNotifyCloseSession(conversationId: string): void {
	if (ext?.readyState !== WebSocket.OPEN) return;
	try {
		ext.send(
			JSON.stringify({ type: "notify", kind: "closeSession", conversationId }),
		);
	} catch {
		// fire-and-forget: a dead socket must not break session shutdown
	}
}
