import { truncateHead, formatSize } from "@earendil-works/pi-coding-agent";

export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;

export const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
			String.fromCodePoint(parseInt(n, 16)),
		)
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
			.replace(
				/<(br|p|div|li|tr|h[1-6]|section|article|header|footer)[^>]*>/gi,
				"\n",
			)
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function truncate(text: string): string {
	const t = truncateHead(text, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
	if (!t.truncated) return t.content;
	return `${t.content}\n\n[Truncated: ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}]`;
}

const BLOCKED_HOSTS =
	/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|169\.254\.169\.254|metadata\.google\.internal)/i;

export function validateUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Only http/https URLs are supported: ${raw}`);
	}
	if (BLOCKED_HOSTS.test(url.hostname)) {
		throw new Error(`Refusing to fetch internal host: ${url.hostname}`);
	}
	return url.toString();
}
