// Smoke test for the pi-side bridge hub: plays the Chrome extension's role
// over the shared hub protocol (extHello + routed requests), then spawns a
// second pi client (scripts/smoke-client.mjs) to exercise client→hub→ext
// routing and the popup's release command.
// Run: node scripts/smoke-bridge.mjs
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

// netns isolates the port but not $HOME: point the token file at a temp
// path BEFORE loading bridge.ts (hub.ts reads it at module load), or this
// run would overwrite a live hub's token and lock out every host client.
// The spawned child inherits the env.
process.env.WEB_SEARCH_HUB_TOKEN_PATH = join(
	tmpdir(),
	`pi-web-search-smoke-token-${process.pid}`,
);
const {
	bridgeCloseGroup,
	bridgeEval,
	bridgeFetch,
	bridgeSearch,
	bridgeSnapshot,
	isBridgeConnected,
	notifyCloseSession,
	startBridge,
	stopBridge,
} = await import("../src/bridge.ts");

const CONVERSATION_ID = "00000000-1111-2222-3333-444444444444";
const CHILD_CID = "child-conv-0000-1111-2222";
const EXT_ORIGIN = "chrome-extension://smoke";
const FAKE_SEARCH_URL = "https://example.com";
const FAKE_FETCH_URLS = ["https://a.example", "https://b.example"];
const FAIL_FETCH_URLS = ["https://fail.example"];

function assert(cond, msg) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

// startBridge binds the hub port 17890. If a *live* pi hub is already
// running, this process falls back to client mode and the assertions below
// would talk to the wrong hub — never run this against a live hub.
const port = await startBridge(CONVERSATION_ID);
console.log(`hub started on port ${port}`);

// Protocol mismatch must be rejected before the real client connects.
{
	const bad = new WebSocket(`ws://127.0.0.1:${port}`, {
		headers: { origin: EXT_ORIGIN },
	});
	await new Promise((resolve) => bad.on("open", resolve));
	bad.send(JSON.stringify({ type: "extHello", protocol: 99 }));
	const ack = await new Promise((resolve) => {
		bad.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === "extHelloAck") resolve(msg);
			} catch {
				// ignore non-JSON frames
			}
		});
	});
	assert(ack.ok === false, "protocol 99 extHello rejected");
	bad.close();
}

// A web page origin must never become a client (forged results) — the hub
// closes it before any message is accepted.
{
	const page = new WebSocket(`ws://127.0.0.1:${port}`, {
		headers: { origin: "https://evil.example" },
	});
	const code = await new Promise((resolve) => {
		page.on("close", (c) => resolve(c));
		page.on("error", () => {});
	});
	assert(code === 4000, "http origin rejected at handshake");
}

// A client register without the hub's token must be rejected (the token
// file is written by startBridge → startHub above).
{
	const bad = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve) => bad.on("open", resolve));
	bad.send(
		JSON.stringify({
			type: "register",
			protocol: 2,
			conversationId: "bad-token-client",
			project: "bad",
			token: "wrong-token",
		}),
	);
	const ack = await new Promise((resolve) => {
		bad.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === "registerAck") resolve(msg);
			} catch {
				// ignore non-JSON frames
			}
		});
	});
	assert(ack.ok === false, "register with bad token rejected");
	bad.close();
}

// With no extension attached, a request must fail loudly with
// EXT_REQUIRED_MSG instead of hanging.
{
	let message = "";
	try {
		await bridgeSearch("no ext query", 3);
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	assert(
		message.includes("Chrome extension not connected"),
		"request without extension fails with EXT_REQUIRED_MSG",
	);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
	headers: { origin: EXT_ORIGIN },
});

const gotCloseSession = new Promise((resolve) => {
	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return; // ignore non-JSON frames in the smoke client
		}
		if (msg.type === "notify" && msg.kind === "closeSession") resolve(msg);
	});
});

let gotChildRequest;
const childRequestSeen = new Promise((resolve) => {
	gotChildRequest = resolve;
});

const sessionsWaiters = [];
let lastSessions = [];
function waitForSessions(pred) {
	// The push may already have landed before the waiter was registered
	// (e.g. release → push happens before the child's "released" event).
	if (pred(lastSessions)) return Promise.resolve(lastSessions);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("timed out waiting for sessions push")),
			5000,
		);
		sessionsWaiters.push((sessions) => {
			if (pred(sessions)) {
				clearTimeout(timer);
				resolve(sessions);
				return true;
			}
			return false;
		});
	});
}

ws.on("message", (data) => {
	let msg;
	try {
		msg = JSON.parse(data.toString());
	} catch {
		return;
	}
	if (msg.type === "sessions") {
		lastSessions = msg.sessions;
		for (let i = sessionsWaiters.length - 1; i >= 0; i--) {
			if (sessionsWaiters[i](msg.sessions)) sessionsWaiters.splice(i, 1);
		}
		return;
	}
	if (msg.type === "request") {
		if (msg.params?.query === "child query") gotChildRequest(msg);
		let result;
		if (msg.kind === "search") {
			result = {
				results: [
					{
						title: "fake result",
						url: FAKE_SEARCH_URL,
						snippet: "from fake extension",
					},
				],
			};
		} else if (msg.kind === "closeGroup") {
			result = { closed: true };
		} else if (msg.kind === "eval") {
			result = { result: `fake eval of ${msg.params.code}` };
		} else if (msg.params.urls.includes(FAIL_FETCH_URLS[0])) {
			result = {
				pages: [],
				failures: [`${FAIL_FETCH_URLS[0]}: tab load timeout`],
			};
		} else if (msg.kind === "snapshot") {
			result = {
				snapshots: msg.params.urls.map((u) => ({
					url: u,
					title: "fake title",
					snapshot: `[0] <a> fake -> ${u}`,
				})),
				failures: [],
			};
		} else {
			result = {
				pages: msg.params.urls.map((u) => ({
					url: u,
					text: `[fake] content of ${u}`,
				})),
				failures: [],
			};
		}
		ws.send(JSON.stringify({ type: "response", rid: msg.rid, ok: true, result }));
	}
});

await new Promise((resolve) => ws.on("open", resolve));
ws.send(JSON.stringify({ type: "extHello", protocol: 2 }));
const ack = await new Promise((resolve) => {
	const onData = (data) => {
		try {
			const msg = JSON.parse(data.toString());
			if (msg.type === "extHelloAck") {
				ws.off("message", onData);
				resolve(msg);
			}
		} catch {
			// ignore non-JSON frames
		}
	};
	ws.on("message", onData);
});
assert(ack.ok === true, "extHello handshake accepted");
const selfEntry = (ack.sessions ?? []).find((s) => s.self);
assert(
	selfEntry?.conversationId === CONVERSATION_ID &&
		typeof selfEntry.project === "string",
	"extHelloAck lists the hub's own session",
);
assert(isBridgeConnected(), "isBridgeConnected() true after handshake");

// The hub has ONE extension slot: a second extHello must be rejected.
{
	const second = new WebSocket(`ws://127.0.0.1:${port}`, {
		headers: { origin: EXT_ORIGIN },
	});
	await new Promise((resolve) => second.on("open", resolve));
	second.send(JSON.stringify({ type: "extHello", protocol: 2 }));
	const ack2 = await new Promise((resolve) => {
		second.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === "extHelloAck") resolve(msg);
			} catch {
				// ignore non-JSON frames
			}
		});
	});
	assert(ack2.ok === false, "second extension connection rejected (single slot)");
	second.close();
}

const results = await bridgeSearch("smoke test query", 5);
assert(results.length === 1 && results[0].url === FAKE_SEARCH_URL, "bridgeSearch returns fake results");

const { pages, failures } = await bridgeFetch(FAKE_FETCH_URLS);
assert(pages.length === 2 && failures.length === 0, "bridgeFetch returns 2 fake pages");
assert(pages[1].text.includes("b.example"), "fetch page text mapped correctly");

const allFailed = await bridgeFetch(FAIL_FETCH_URLS);
assert(
	allFailed.pages.length === 0 && allFailed.failures.length === 1,
	"all-failures fetch response passes through",
);

const { snapshots } = await bridgeSnapshot(FAKE_FETCH_URLS, 8000);
assert(
	snapshots.length === 2 && snapshots[0].snapshot.includes("[0] <a>"),
	"bridgeSnapshot returns fake snapshots",
);

const evalResult = await bridgeEval(FAKE_FETCH_URLS[0], "1+1");
assert(evalResult === "fake eval of 1+1", "bridgeEval returns fake result");

const closed = await bridgeCloseGroup();
assert(closed === true, "bridgeCloseGroup returns closed flag");

// --- client mode: a second pi process registers, is routed, is released ---

const child = spawn(process.execPath, ["scripts/smoke-client.mjs"], {
	stdio: ["ignore", "pipe", "inherit"],
});
const childEvents = {};
const childWaiters = {};
function waitChildEvent(event) {
	if (childEvents[event]) return Promise.resolve(childEvents[event]);
	return new Promise((resolve, reject) => {
		childWaiters[event] = resolve;
		setTimeout(() => reject(new Error(`child never reported ${event}`)), 15000);
	});
}
let childBuf = "";
child.stdout.on("data", (chunk) => {
	childBuf += chunk;
	let idx;
	while ((idx = childBuf.indexOf("\n")) >= 0) {
		const line = childBuf.slice(0, idx).trim();
		childBuf = childBuf.slice(idx + 1);
		if (!line) continue;
		try {
			const evt = JSON.parse(line);
			childEvents[evt.event] = evt;
			childWaiters[evt.event]?.(evt);
		} catch {
			console.error(`child: non-JSON line: ${line}`);
		}
	}
});

const regEvt = await waitChildEvent("registered");
assert(regEvt.connected === true, "child registered with the hub as a client");

const withChild = await waitForSessions((s) =>
	s.some((e) => e.conversationId === CHILD_CID && !e.self),
);
const childEntry = withChild.find((e) => e.conversationId === CHILD_CID);
assert(!!childEntry, "sessions push lists the child client");

const searchEvt = await waitChildEvent("search");
assert(searchEvt.url === FAKE_SEARCH_URL, "child search routed through the hub");
const childReq = await childRequestSeen;
assert(
	childReq.conversationId === CHILD_CID,
	"routed request carries the child's conversationId",
);

ws.send(JSON.stringify({ type: "release", clientId: childEntry.clientId }));
await waitChildEvent("released");
assert(true, "hub dropped the child on release");
await waitForSessions((s) => !s.some((e) => e.conversationId === CHILD_CID));
assert(true, "sessions push no longer lists the released child");

// The released child must re-register lazily on its next request — the
// documented recovery, previously gated dead by isBridgeConnected.
const relinkEvt = await waitChildEvent("relinked");
assert(
	relinkEvt.url === FAKE_SEARCH_URL,
	"released child re-links lazily on next request",
);
await waitForSessions((s) =>
	s.some((e) => e.conversationId === CHILD_CID && !e.self),
);
assert(true, "sessions push lists the re-registered child");

// --- session shutdown notify ---

notifyCloseSession();
const closeMsg = await gotCloseSession;
assert(closeMsg.conversationId === CONVERSATION_ID, "closeSession notify carries conversationId");

ws.close();
await new Promise((r) => setTimeout(r, 200));
assert(!isBridgeConnected(), "hub reports extension gone after disconnect");

// Hub-exit takeover: stopping this hub must make the surviving client
// rebind the port and become the new hub.
await stopBridge();
await waitChildEvent("became-hub");
assert(true, "child rebinds the port and takes over as hub");

console.log("all smoke tests passed");
process.exit(0);
