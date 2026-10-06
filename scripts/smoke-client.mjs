// Child process for smoke-bridge.mjs: registers with the hub as a second
// pi client (its startBridge finds the port taken → client mode), issues
// one routed search, then reports the popup-release drop, the lazy re-link
// on the next request, and finally the hub-exit takeover (its reconnect
// loop rebinds the port and it becomes the hub). Events go to stdout as
// JSON lines for the parent to assert on.
import {
	bridgeRole,
	bridgeSearch,
	isBridgeConnected,
	startBridge,
} from "../src/bridge.ts";

const CID = "child-conv-0000-1111-2222";

// Run standalone (without the parent's env), this would bind 17890 inside
// the netns, become a hub, and overwrite the REAL token file — locking
// every host client out of the live hub until it restarts.
if (!process.env.WEB_SEARCH_HUB_TOKEN_PATH) {
	console.error("smoke-client: run via scripts/smoke-bridge.mjs (token path not set)");
	process.exit(1);
}

await startBridge(CID);
console.log(JSON.stringify({ event: "registered", connected: isBridgeConnected() }));

try {
	const results = await bridgeSearch("child query", 3);
	console.log(JSON.stringify({ event: "search", url: results[0]?.url ?? null }));
} catch (err) {
	console.log(
		JSON.stringify({
			event: "search",
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

const timer = setInterval(() => {
	if (!isBridgeConnected()) {
		clearInterval(timer);
		console.log(JSON.stringify({ event: "released" }));
		void (async () => {
			// Lazy re-link: the first request after a release must
			// re-register without a restart.
			try {
				const results = await bridgeSearch("child relink query", 3);
				console.log(
					JSON.stringify({ event: "relinked", url: results[0]?.url ?? null }),
				);
			} catch (err) {
				console.log(
					JSON.stringify({
						event: "relinked",
						error: err instanceof Error ? err.message : String(err),
					}),
				);
				process.exit(1);
			}
			// Hub-exit takeover: the parent stops the hub next; this
			// client's reconnect loop must rebind the port.
			const roleTimer = setInterval(() => {
				if (bridgeRole() === "hub") {
					clearInterval(roleTimer);
					console.log(JSON.stringify({ event: "became-hub" }));
					process.exit(0);
				}
			}, 200);
		})();
	}
}, 100);
// Watchdog: the parent asserts before this ever fires.
setTimeout(() => process.exit(2), 30000).unref();
