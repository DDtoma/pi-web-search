import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "./search.ts";
import { renderPage } from "./render.ts";
import {
	DEFAULT_SUMMARY_MODEL,
	loadConfig,
	MAX_FETCH_COUNT,
	resolveFetchCount,
	resolveRenderer,
	summarize,
	saveConfig,
} from "./summarize.ts";
import { truncate } from "./text.ts";

const PER_PAGE_TIMEOUT_MS = 15_000;
/** Per-page cap before feeding pages into the summary call */
const PAGE_SUMMARY_BYTES = 30 * 1024;
const MAX_FETCH_URLS = 10;

function capForSummary(text: string): string {
	return text.length > PAGE_SUMMARY_BYTES
		? `${text.slice(0, PAGE_SUMMARY_BYTES)}\n[…truncated]`
		: text;
}

type FetchedPage = {
	url: string;
	text: string;
	renderer: string;
};

async function fetchPages(
	urls: string[],
	signal?: AbortSignal,
): Promise<{ pages: FetchedPage[]; failures: string[] }> {
	const settled = await Promise.allSettled(
		urls.map(async (url): Promise<FetchedPage> => {
			const { text, renderer } = await renderPage(url, {
				timeoutMs: PER_PAGE_TIMEOUT_MS,
				prefer: resolveRenderer(),
				...(signal ? { signal } : {}),
			});
			return { url, text, renderer };
		}),
	);
	const pages: FetchedPage[] = [];
	const failures: string[] = [];
	settled.forEach((s, i) => {
		if (s.status === "fulfilled") {
			pages.push(s.value);
		} else {
			failures.push(
				`${urls[i] ?? "?"}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
			);
		}
	});
	return { pages, failures };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web (Google, DuckDuckGo fallback) and return result links with title and snippet. Use web_fetch to get the content of specific URLs.",
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
			"Fetch one or more web pages with a real browser renderer (falls back to plain HTTP) and return their text content (each page truncated to 30KB, overall output capped at 50KB / 2000 lines). Pass question to get an LLM summary of all pages focused on it.",
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
			const { pages, failures } = await fetchPages(
				params.urls,
				signal ?? undefined,
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
					.map(
						(p) => `## ${p.url} [renderer: ${p.renderer}]\n${capForSummary(p.text)}`,
					)
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
			const content = pages
				.map(
					(p, i) =>
						`<page index="${i + 1}" url="${p.url}">\n${capForSummary(p.text)}\n</page>`,
				)
				.join("\n\n");
			const summary = await summarize(
				content,
				params.question,
				ctx,
				signal ?? undefined,
			);
			const sources = pages.map((p) => `- ${p.url} [${p.renderer}]`).join("\n");
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
