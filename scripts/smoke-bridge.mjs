// Smoke test for the pi-side bridge: plays the Chrome extension's role with
// a fake ws client, then exercises startBridge → hello → search → fetch →
// closeSession → stopBridge. Run: node scripts/smoke-bridge.mjs
import { WebSocket } from "ws";
import {
	bridgeFetch,
	bridgeSearch,
	isBridgeConnected,
	notifyCloseSession,
	startBridge,
	stopBridge,
} from "../src/bridge.ts";

const CONVERSATION_ID = "00000000-1111-2222-3333-444444444444";
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

// startBridge binds the first free port in the range and returns it — use
// that port directly. Scanning for any open port would find a *live* pi
// instance's bridge when one is running, and its single-connection rule
// would reject our hello.
const port = await startBridge(CONVERSATION_ID);
console.log(`server started on port ${port}`);

// Protocol mismatch must be rejected before the real client connects.
{
	const bad = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve) => bad.on("open", resolve));
	bad.send(JSON.stringify({ type: "hello", protocol: 99 }));
	const ack = await new Promise((resolve) => {
		bad.on("message", (data) => {
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.type === "helloAck") resolve(msg);
		});
	});
	assert(ack.ok === false, "protocol 99 hello rejected");
	bad.close();
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);

const gotCloseSession = new Promise((resolve) => {
	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return; // ignore non-JSON frames in the smoke client
		}
		if (msg.type === "notify" && msg.kind === "closeSession") resolve(msg);
		if (msg.type === "request") {
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
			} else if (msg.params.urls.includes(FAIL_FETCH_URLS[0])) {
				result = {
					pages: [],
					failures: [`${FAIL_FETCH_URLS[0]}: tab load timeout`],
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
			ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
		}
	});
});

await new Promise((resolve) => ws.on("open", resolve));
ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
const ack = await new Promise((resolve) => {
	const onData = (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return; // ignore non-JSON frames in the smoke client
		}
		if (msg.type === "helloAck") {
			ws.off("message", onData);
			resolve(msg);
		}
	};
	ws.on("message", onData);
});
assert(ack.ok === true, "hello handshake accepted");
assert(isBridgeConnected(), "isBridgeConnected() true after handshake");

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

notifyCloseSession();
const closeMsg = await gotCloseSession;
assert(closeMsg.conversationId === CONVERSATION_ID, "closeSession notify carries conversationId");

ws.close();
await new Promise((r) => setTimeout(r, 200));
assert(!isBridgeConnected(), "bridge cleared after client disconnect");

await stopBridge();
console.log("all smoke tests passed");
process.exit(0);
