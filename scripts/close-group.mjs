// Close pi tab groups via the real Chrome extension. Usage:
//   node scripts/close-group.mjs            → close the compare-script test group
//   node scripts/close-group.mjs --all      → close every pi tab group
//   node scripts/close-group.mjs <uuid>     → close that conversation's group
import {
	bridgeCloseGroup,
	isBridgeConnected,
	startBridge,
	stopBridge,
} from "../src/bridge.ts";

const arg = process.argv[2];
const id = arg === "--all" ? "*" : (arg ?? "00000000-0000-0000-0000-0000000000c0");

await startBridge(id);
for (let i = 0; i < 240 && !isBridgeConnected(); i++) {
	await new Promise((r) => setTimeout(r, 500));
}
if (!isBridgeConnected()) {
	console.error("extension never connected — is it loaded in Chrome?");
	process.exit(1);
}
const closed = await bridgeCloseGroup();
console.log(closed ? "tab group(s) closed" : "no matching group found");
await stopBridge();
process.exit(0);
