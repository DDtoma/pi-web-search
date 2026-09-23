// Unit test for the page cache: filename determinism/collision resistance,
// folder layout, file content, summarized note. Run: node scripts/test-cache.mjs
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheFileName, cachePage } from "../src/cache.ts";

const SESSION_DIR = join(tmpdir(), "pi-web-search-test-sessions");
const SESSION_ID = "test-session";

function assert(cond, msg) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

// Filenames are deterministic per URL and collision-resistant across URLs.
const a = cacheFileName("https://example.com/docs/guide?x=1");
assert(a === cacheFileName("https://example.com/docs/guide?x=1"), "filename deterministic");
assert(a !== cacheFileName("https://example.com/docs/guide?x=2"), "no collision on query change");
assert(
	/^example\.com_docs_guide_x_1-[0-9a-f]{8}\.txt$/.test(a),
	`slug-hash naming: ${a}`,
);

// Files land in <sessionDir>/web-search-cache/<sessionId>/ with a header.
const p1 = cachePage(SESSION_DIR, SESSION_ID, "https://example.com/docs/guide?x=1", "raw page text");
assert(
	p1 === join(SESSION_DIR, "web-search-cache", SESSION_ID, a),
	`cache layout: ${p1}`,
);
const c1 = readFileSync(p1, "utf8");
assert(
	c1.startsWith("URL: https://example.com/docs/guide?x=1\nFetched:") && c1.endsWith("raw page text"),
	"file header + content",
);

// Extension-side summaries are marked so they are not mistaken for raw text.
const p2 = cachePage(SESSION_DIR, SESSION_ID, "https://example.com/other", "summary text", true);
assert(
	readFileSync(p2, "utf8").includes("NOTE: extension-side LLM summary"),
	"summarized note present",
);

rmSync(SESSION_DIR, { recursive: true, force: true });
console.log("all cache tests passed");
