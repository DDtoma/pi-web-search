import { UA, decodeEntities, htmlToText } from "./text.ts";

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchOutcome = {
	engine: string;
	results: SearchResult[];
};

function decodeDuckDuckGoUrl(href: string): string {
	const u = /[?&]uddg=([^&]+)/.exec(href);
	const raw = u?.[1];
	if (raw) {
		try {
			return decodeURIComponent(raw);
		} catch {
			return href;
		}
	}
	return href;
}

async function googleSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const response = await fetch(
		`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(maxResults, 20)}&hl=zh-CN`,
		{ headers: { "User-Agent": UA }, signal },
	);
	if (!response.ok) throw new Error(`Google returned HTTP ${response.status}`);
	const html = await response.text();
	if (/consent\.google|unusual traffic|recaptcha/i.test(html)) {
		throw new Error("Google returned a consent/anti-bot page");
	}

	const results: SearchResult[] = [];
	// Result blocks: <a href="URL" ...><h3>Title</h3> — skip google-internal links
	const linkRe =
		/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(html)) !== null) {
		const href = m[1];
		const titleHtml = m[2];
		if (!href || !titleHtml) continue;
		const url = decodeEntities(href);
		try {
			if (/\.?google\.com/.test(new URL(url).hostname)) continue;
		} catch {
			continue; // malformed URL — skip
		}
		const title = htmlToText(titleHtml);
		if (!title) continue;
		results.push({ url, title, snippet: "" });
		if (results.length >= maxResults) break;
	}
	if (results.length === 0)
		throw new Error("Google returned no parseable results");
	return results;
}

async function duckDuckGoSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const response = await fetch(
		`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
		{ headers: { "User-Agent": UA }, signal },
	);
	if (!response.ok)
		throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
	const html = await response.text();

	const results: SearchResult[] = [];
	for (const block of html.split("result__body").slice(1)) {
		const m =
			/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
				block,
			);
		if (!m) continue;
		const href = m[1];
		const titleHtml = m[2];
		if (!href || !titleHtml) continue;
		const s = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		results.push({
			url: decodeDuckDuckGoUrl(decodeEntities(href)),
			title: htmlToText(titleHtml),
			snippet: s?.[1] ? htmlToText(s[1]) : "",
		});
		if (results.length >= maxResults) break;
	}
	if (results.length === 0)
		throw new Error("DuckDuckGo returned no parseable results");
	return results;
}

// Google now serves a JS-only shell to plain fetches and an anti-bot
// interstitial to headless browsers. Keep trying it (it works from some
// networks), but remember a failure for the process lifetime so we don't
// pay the ~2s penalty on every search.
let googleUnavailable = false;

export async function search(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	if (!googleUnavailable) {
		try {
			return {
				engine: "google",
				results: await googleSearch(query, maxResults, signal),
			};
		} catch (err) {
			// An aborted search must surface as an abort, not as a permanent
			// "Google unavailable" downgrade followed by a doomed DDG retry.
			if (signal?.aborted) throw err;
			googleUnavailable = true;
		}
	}
	return {
		engine: "duckduckgo",
		results: await duckDuckGoSearch(query, maxResults, signal),
	};
}
