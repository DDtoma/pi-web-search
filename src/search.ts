import { bridgeSearch, isBridgeConnected } from "./bridge.ts";

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
	if (!isBridgeConnected()) {
		throw new Error(
			"Chrome extension not connected. Load extension/ in chrome://extensions and make sure it connected to this pi instance (ports 17890–17899).",
		);
	}
	return {
		engine: "google (browser)",
		results: await bridgeSearch(query, maxResults, signal),
	};
}
