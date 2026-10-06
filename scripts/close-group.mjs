// Close pi tab groups via the real Chrome extension. Usage:
//   node scripts/close-group.mjs            → close the compare-script test group
//   node scripts/close-group.mjs --all      → close every pi tab group
//   node scripts/close-group.mjs <uuid>     → close that conversation's group
import {
	bridgeCloseGroup,
	startBridge,
	stopBridge,
} from "../src/bridge.ts";

const arg = process.argv[2];
const id = arg === "--all" ? "*" : (arg ?? "00000000-0000-0000-0000-0000000000c0");

await startBridge(id);
// No isBridgeConnected gate: as a client it only means "hub socket open"
// and says nothing about the extension. The real extension state surfaces
// as the request's error message.
let closed;
try {
	closed = await bridgeCloseGroup();
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
console.log(closed ? "tab group(s) closed" : "no matching group found");
await stopBridge();
process.exit(0);
