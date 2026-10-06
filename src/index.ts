import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "./search.ts";
import {
	bridgeFetch,
	bridgeEval,
	bridgeSnapshot,
	notifyCloseSession,
	startBridge,
	stopBridge,
} from "./bridge.ts";
import { validateUrl } from "./text.ts";
import { cachePage } from "./cache.ts";
import {
	DEFAULT_SUMMARY_MODEL,
	loadConfig,
	MAX_FETCH_COUNT,
	resolveFetchCount,
	summarize,
	saveConfig,
} from "./summarize.ts";
import { MAX_BYTES, truncate } from "./text.ts";

/** Per-page cap (chars) before feeding pages into the summary call */
const PAGE_SUMMARY_CHARS = 30 * 1024;
/** Total budget (chars) for all pages in one summary call */
const TOTAL_SUMMARY_CHARS = 100 * 1024;
const MAX_FETCH_URLS = 10;

function capForSummary(text: string, cap: number = PAGE_SUMMARY_CHARS): string {
	if (text.length <= cap) return text;
	let s = text.slice(0, cap);
	// slice() counts UTF-16 code units — drop a trailing lone high
	// surrogate so non-BMP characters are not split in half.
	const last = s.charCodeAt(s.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
	return `${s}\n[…truncated]`;
}

type FetchedPage = {
	url: string;
	text: string;
	/** True when the extension replaced page text with its own LLM summary. */
	summarized?: boolean;
	/** Path of the on-disk raw copy, when the cache write succeeded. */
	cachePath?: string;
};

// Fetch goes through the Chrome extension's real browser tabs only — no
// local fallback, same policy as web_search: without the extension the tool
// fails loudly instead of silently serving degraded content.
async function fetchPagesViaBridge(
	urls: string[],
	signal?: AbortSignal,
	question?: string,
): Promise<{ pages: FetchedPage[]; failures: string[] }> {
	const checkedUrls = urls.map(validateUrl);
	// With a question, the extension summarizes each page on its side (when
	// its LLM endpoint is configured) and returns summaries as page text.
	const { pages, failures } = await bridgeFetch(checkedUrls, signal, question);
	if (pages.length === 0 && failures.length === 0) {
		throw new Error("bridge fetch returned nothing");
	}
	return { pages, failures };
}

export default function (pi: ExtensionAPI) {
	// The bridge server is session-scoped on purpose: pi re-imports this
	// module on /reload, and a server owned by the old module instance would
	// leak its port. startBridge/stopBridge are idempotent.
	pi.on("session_start", async (_event, ctx) => {
		try {
			await startBridge(ctx.sessionManager.getSessionId());
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`web-search bridge disabled: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}
	});
	pi.on("session_shutdown", async () => {
		notifyCloseSession();
		await stopBridge();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Google in a real browser tab (requires the Chrome extension bridge) and return result links with title and snippet. Use web_fetch to get the content of specific URLs.",
		promptSnippet: "Search the web, return result links and snippets",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(
				Type.Number({
					description: "How many results to return (default 5, max 10)",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, _ctx) {
			const count = Math.min(
				Math.max(
					Math.floor(params.maxResults ?? resolveFetchCount(loadConfig())),
					1,
				),
				MAX_FETCH_COUNT,
			);
			onUpdate?.({
				content: [{ type: "text", text: `Searching: ${params.query}` }],
				details: {},
			});
			const { engine, results } = await search(
				params.query,
				count,
				signal ?? undefined,
			);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { engine, results: [] },
				};
			}
			const list = results
				.map(
					(r, i) =>
						`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
				)
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: `Search engine: ${engine}\n\n${list}`,
					},
				],
				details: { engine, results },
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch one or more web pages via the Chrome extension bridge in real browser tabs (requires the extension; no local fallback). Two modes: \"content\" (default) returns text content (each page truncated to 30KB, overall output capped at 50KB / 2000 lines; each page's full text is also cached to a local file — the result lists the paths, use the read tool to access complete page content later); \"outline\" returns a compact YAML structural skeleton — typically far smaller, use it to understand page structure and identify interactive elements before driving a page. Pass question to get an LLM summary of all pages focused on it (content mode only).",
		promptSnippet: "Fetch rendered web pages as text, optional LLM summary",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ description: "URL to fetch" }), {
				description: "URLs to fetch (1-10), fetched in parallel",
				minItems: 1,
				maxItems: MAX_FETCH_URLS,
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("content"), Type.Literal("outline")], {
					description:
						'Output mode: "content" (default) returns page text; "outline" returns a compact YAML structural skeleton (nested containers, quoted text runs, numbered interactive elements tag[N]: "label" -> href) — much smaller, use it to understand page structure and identify elements. Outline reuses the tab left open by an earlier fetch of the same URL when one exists (no reload, reflects the live DOM); use the [N] refs via `[data-pi-ref=\"N\"]` selectors with web_eval.',
				}),
			),
			question: Type.Optional(
				Type.String({
					description:
						'Focus question for an LLM summary over all pages (content mode only)',
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description:
						"Per-page outline size cap in chars, default 8000 (outline mode only)",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [
					{ type: "text", text: `Fetching ${params.urls.length} page(s)...` },
				],
				details: {},
			});
			if (params.mode === "outline") {
				const urls = params.urls.map(validateUrl);
				// Scale the per-page cap by URL count so the joined body stays
				// under truncate()'s byte budget instead of losing tail pages.
				// MAX_BYTES is bytes but maxChars counts UTF-16 chars — budget
				// 3 bytes/char (worst case for CJK UTF-8) or tail pages get cut.
				const maxChars = Math.min(
					Math.max(Math.floor(params.maxChars ?? 8000), 500),
					30000,
					Math.max(Math.floor(MAX_BYTES / 3 / urls.length) - 200, 500),
				);
				const { snapshots, failures } = await bridgeSnapshot(
					urls,
					maxChars,
					signal ?? undefined,
				);
				const failedNote = failures.length
					? `\nFailed pages:\n${failures.map((f) => `- ${f}`).join("\n")}`
					: "";
				if (snapshots.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Every page failed to load:${failedNote}`,
							},
						],
						details: { urls, failures },
					};
				}
				const body = snapshots
					.map((s) => `## ${s.url}\n[${s.title}]\n${s.snapshot}`)
					.join("\n\n");
				return {
					content: [{ type: "text", text: `${truncate(body)}${failedNote}` }],
					details: { urls, snapshots, failures },
				};
			}
			const { pages, failures } = await fetchPagesViaBridge(
				params.urls,
				signal ?? undefined,
				params.question,
			);
			if (pages.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Every page failed to load:\n${failures.map((f) => `- ${f}`).join("\n")}`,
						},
					],
					details: { urls: params.urls, failures },
				};
			}
			const failedNote = failures.length
				? `\nFailed pages:\n${failures.map((f) => `- ${f}`).join("\n")}`
				: "";
			// Persist every page's text so the agent can re-read full content
			// with the read tool after this result (which is truncated) is gone.
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionDir = ctx.sessionManager.getSessionDir();
			const cachedLines: string[] = [];
			for (const p of pages) {
				p.cachePath = cachePage(
					sessionDir,
					sessionId,
					p.url,
					p.text,
					p.summarized,
				);
				if (p.cachePath) cachedLines.push(`- ${p.url} → ${p.cachePath}`);
			}
			const cacheNote = cachedLines.length
				? `\nRaw page copies (read with the read tool):\n${cachedLines.join("\n")}`
				: "";
			if (!params.question) {
				const body = pages
					.map((p) => `## ${p.url}\n${capForSummary(p.text)}`)
					.join("\n\n");
				return {
					content: [
						{ type: "text", text: `${truncate(body)}${cacheNote}${failedNote}` },
					],
					details: { urls: params.urls, pages, failures },
				};
			}
			onUpdate?.({
				content: [{ type: "text", text: "Summarizing..." }],
				details: {},
			});
			// Cap the total so 10 full pages can't blow the summary model's
			// context: with more pages, each gets a smaller share of the budget.
			const perPage = Math.min(
				PAGE_SUMMARY_CHARS,
				Math.floor(TOTAL_SUMMARY_CHARS / pages.length),
			);
			const content = pages
				.map(
					(p, i) =>
						`<page index="${i + 1}" url="${p.url}">\n${capForSummary(p.text, perPage)}\n</page>`,
				)
				.join("\n\n");
			const summary = await summarize(
				content,
				params.question,
				ctx,
				signal ?? undefined,
			);
			const sources = pages.map((p) => `- ${p.url}`).join("\n");
			return {
				content: [
					{
						type: "text",
						text: `${summary.text}\n\n---\nSummary by ${summary.model}\nSources:\n${sources}${cacheNote}${failedNote}`,
					},
				],
				details: { urls: params.urls, pages, failures },
				usage: summary.usage,
			};
		},
	});

	pi.registerTool({
		name: "web_eval",
		label: "Web Eval",
		description:
			"Run arbitrary JavaScript in a page already opened by web_fetch (either mode; requires the extension; MAIN world, exempt from page CSP). The page is never navigated by this tool — it must already be open in this session's tab group. Use outline mode's [N] refs to target elements, e.g. document.querySelector('[data-pi-ref=\"7\"]').click(). Returns the JSON-serializable value of the expression (Promises are awaited; DOM nodes and functions come back as null — return strings/numbers/plain objects instead).",
		promptSnippet: "Run JS in an already-open page",
		parameters: Type.Object({
			url: Type.String({
				description: "URL of the already-open tab to run the code in",
			}),
			code: Type.String({
				description: "JavaScript expression or statements to evaluate",
			}),
		}),
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const url = validateUrl(params.url);
			const result = await bridgeEval(url, params.code, signal ?? undefined);
			const text =
				typeof result === "string"
					? result
					: JSON.stringify(result, null, 2) ?? "undefined";
			return {
				content: [{ type: "text", text: truncate(text) }],
				details: { url, result },
			};
		},
	});

	pi.registerCommand("web-search-model", {
		description:
			"Pick the model and thinking level used for web summary (saved to ~/.pi/agent/web-search.json)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const config = loadConfig();
			const current =
				process.env.WEB_SUMMARY_MODEL ??
				config.summaryModel ??
				DEFAULT_SUMMARY_MODEL;
			const models = ctx.modelRegistry
				.getAvailable()
				.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
			const choice = await ctx.ui.select(`Summary model (current: ${current})`, [
				`(default: ${DEFAULT_SUMMARY_MODEL})`,
				"(use current session model)",
				...models.map((m) => `${m.provider}/${m.id}`),
			]);
			if (!choice) return;
			if (choice.startsWith("(default")) {
				saveConfig({ ...config, summaryModel: undefined });
				ctx.ui.notify(`Summary model reset to ${DEFAULT_SUMMARY_MODEL}`, "info");
			} else if (choice.startsWith("(")) {
				saveConfig({ ...config, summaryModel: "session" });
				ctx.ui.notify("Will use the current session model", "info");
			} else {
				saveConfig({ ...config, summaryModel: choice });
				ctx.ui.notify(`Summary model set to ${choice}`, "info");
			}
		},
	});
}
