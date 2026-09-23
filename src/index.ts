import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "./search.ts";
import {
	BRIDGE_REQUIRED_MSG,
	bridgeFetch,
	isBridgeConnected,
	notifyCloseSession,
	startBridge,
	stopBridge,
} from "./bridge.ts";
import { validateUrl } from "./text.ts";
import {
	DEFAULT_SUMMARY_MODEL,
	loadConfig,
	MAX_FETCH_COUNT,
	resolveFetchCount,
	summarize,
	saveConfig,
} from "./summarize.ts";
import { truncate } from "./text.ts";

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
			"Fetch one or more web pages via the Chrome extension bridge in real browser tabs (requires the extension; no local fallback). Returns text content (each page truncated to 30KB, overall output capped at 50KB / 2000 lines). Pass question to get an LLM summary of all pages focused on it.",
		promptSnippet: "Fetch rendered web pages as text, optional LLM summary",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ description: "URL to fetch" }), {
				description: "URLs to fetch (1-10), fetched in parallel",
				minItems: 1,
				maxItems: MAX_FETCH_URLS,
			}),
			question: Type.Optional(
				Type.String({
					description: "Focus question for an LLM summary over all pages",
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
			if (!isBridgeConnected()) {
				throw new Error(BRIDGE_REQUIRED_MSG);
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
			if (!params.question) {
				const body = pages
					.map((p) => `## ${p.url}\n${capForSummary(p.text)}`)
					.join("\n\n");
				return {
					content: [{ type: "text", text: `${truncate(body)}${failedNote}` }],
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
						text: `${summary.text}\n\n---\nSummary by ${summary.model}\nSources:\n${sources}${failedNote}`,
					},
				],
				details: { urls: params.urls, pages, failures },
				usage: summary.usage,
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
