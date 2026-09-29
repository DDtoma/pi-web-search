// Compare extractPageText (fetch) vs distillPage (snapshot) on the same
// live pages through the real Chrome extension. Requires the extension
// reloaded after the snapshot handler was added.
// Run: node scripts/compare-extract.mjs
import { writeFileSync } from "node:fs";
import {
	bridgeCloseGroup,
	bridgeFetch,
	bridgeSnapshot,
	isBridgeConnected,
	startBridge,
	stopBridge,
} from "../src/bridge.ts";

const URLS = [
	"https://example.com",
	"https://www.baidu.com",
	"https://github.com/earendil-works/pi-coding-agent",
	"https://www.rfc-editor.org/rfc/rfc9110",
];

const port = await startBridge("00000000-0000-0000-0000-0000000000c0");
console.log(`bridge on ${port}, waiting for extension...`);
for (let i = 0; i < 240 && !isBridgeConnected(); i++) {
	await new Promise((r) => setTimeout(r, 500));
}
if (!isBridgeConnected()) {
	console.error("extension never connected — is it loaded in Chrome?");
	process.exit(1);
}
console.log("extension connected\n");

for (const url of URLS) {
	const [{ pages, failures: f1 }, { snapshots, failures: f2 }] =
		await Promise.all([bridgeFetch([url]), bridgeSnapshot([url], 8000)]);
	if (f1.length || f2.length) {
		console.log(`${url}\n  FAILURES: ${[...f1, ...f2].join("; ")}`);
		continue;
	}
	const text = pages[0].text;
	const snap = snapshots[0].snapshot;
	const safe = url.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
	writeFileSync(`/tmp/compare_${safe}.txt`, text);
	writeFileSync(`/tmp/compare_${safe}.snap.txt`, snap);
	const ratio = ((snap.length / text.length) * 100).toFixed(1);
	console.log(`${url}`);
	console.log(`  fetch text : ${text.length} chars  -> /tmp/compare_${safe}.txt`);
	console.log(
		`  snapshot   : ${snap.length} chars (${ratio}% of fetch)  -> /tmp/compare_${safe}.snap.txt`,
	);
	console.log(`  snapshot head:\n${snap.split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n")}`);
	console.log();
}

// Self-clean: don't leave the test tab group behind.
const closed = await bridgeCloseGroup();
console.log(closed ? "test tab group closed" : "no test tab group to close");

await stopBridge();
process.exit(0);
