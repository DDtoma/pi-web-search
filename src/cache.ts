// Raw page cache: every fetched page's text is written next to pi's own
// session history, at <sessionDir>/web-search-cache/<sessionId>/, so browsing
// a workspace's session folder shows conversations and fetched pages side by
// side (sessionDir = ~/.pi/agent/sessions/<workspace>/). The tool result
// itself is truncated; the agent re-reads full content from these files.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Deterministic per URL: readable slug + collision guard. */
export function cacheFileName(url: string): string {
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
	let slug = url
		.replace(/^https?:\/\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (slug.length > 80) slug = slug.slice(0, 80);
	return `${slug || "page"}-${hash}.txt`;
}

/**
 * Write one page's text to the session cache folder. Returns the file path,
 * or undefined on failure — caching must never break the tool call.
 */
export function cachePage(
	sessionDir: string,
	sessionId: string,
	url: string,
	text: string,
	summarized?: boolean,
): string | undefined {
	try {
		const dir = join(sessionDir, "web-search-cache", sessionId);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, cacheFileName(url));
		const note = summarized
			? "\nNOTE: extension-side LLM summary, not raw page text.\n"
			: "\n";
		writeFileSync(
			file,
			`URL: ${url}\nFetched: ${new Date().toISOString()}${note}\n${text}`,
		);
		return file;
	} catch {
		return undefined;
	}
}
