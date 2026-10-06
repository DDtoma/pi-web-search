import { bridgeSearch } from "./bridge.ts";

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchOutcome = {
	engine: string;
	results: SearchResult[];
};

// Search only goes through the Chrome extension bridge: a real browser tab
// gets past Google's JS-shell/anti-bot responses. No local fallback — when
// the extension is not connected, fail loudly instead of silently serving
// degraded results.
export async function search(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	// No isBridgeConnected pre-gate here: after a popup release the link is
	// down but re-links lazily inside bridgeSearch — gating here would make
	// that recovery unreachable. A genuinely missing extension surfaces as
	// EXT_REQUIRED_MSG from the bridge itself.
	return {
		engine: "google (browser)",
		results: await bridgeSearch(query, maxResults, signal),
	};
}
