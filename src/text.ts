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
			.replace(/<head[\s\S]*?<\/head>/gi, "")
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

// Loopback, RFC1918 private ranges, link-local, ULA, IPv4-mapped IPv6, and
// cloud metadata endpoints. DNS names that resolve to private IPs are NOT
// covered — that would require resolution-time checks.
const BLOCKED_IPV4 =
	/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|metadata\.google\.internal)/i;
// Node keeps brackets on IPv6 hostnames: "[::1]", "[fe80::1]".
const BLOCKED_IPV6 = /^\[?(::1|::|fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}|::ffff:)/i;

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
	if (
		BLOCKED_IPV4.test(url.hostname) ||
		BLOCKED_IPV6.test(url.hostname) ||
		url.hostname.endsWith(".localhost")
	) {
		throw new Error(`Refusing to fetch internal host: ${url.hostname}`);
	}
	return url.toString();
}
