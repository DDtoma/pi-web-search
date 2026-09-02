import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search, type SearchResult } from "./search.ts";
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

function capForSummary(text: string): string {
	return text.length > PAGE_SUMMARY_BYTES
		? `${text.slice(0, PAGE_SUMMARY_BYTES)}\n[…truncated]`
		: text;
}

type FetchedPage = {
	url: string;
	title: string;
	text: string;
	renderer: string;
};

async function fetchPages(
	results: SearchResult[],
	signal?: AbortSignal,
): Promise<{ pages: FetchedPage[]; failures: string[] }> {
	const settled = await Promise.allSettled(
		results.map(async (r): Promise<FetchedPage> => {
			const { text, renderer } = await renderPage(r.url, {
				timeoutMs: PER_PAGE_TIMEOUT_MS,
				prefer: resolveRenderer(),
				...(signal ? { signal } : {}),
			});
			return { url: r.url, title: r.title, text, renderer };
		}),
	);
	const pages: FetchedPage[] = [];
	const failures: string[] = [];
	settled.forEach((s, i) => {
		if (s.status === "fulfilled") {
			pages.push(s.value);
		} else {
			const r = results[i];
			failures.push(
				`${r?.title ?? "?"} (${r?.url ?? "?"}): ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
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
			"Search the web (Google, DuckDuckGo fallback), fetch the top result pages with a real browser renderer, and return an LLM summary focused on the query, with source URLs.",
		promptSnippet: "Search the web, fetch top pages, summarize around the query",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(
				Type.Number({
					description: "How many result pages to fetch (default 5, max 10)",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
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
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Fetching ${results.length} pages (${engine})...`,
					},
				],
				details: {},
			});
			const { pages, failures } = await fetchPages(results, signal ?? undefined);
			if (pages.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Search via ${engine} found ${results.length} results, but every page failed to load:\n${failures.map((f) => `- ${f}`).join("\n")}`,
						},
					],
					details: { engine, results, failures },
				};
			}
			onUpdate?.({
				content: [{ type: "text", text: "Summarizing..." }],
				details: {},
			});
			const content = pages
				.map(
					(p, i) =>
						`<page index="${i + 1}" url="${p.url}" title="${p.title}">\n${capForSummary(p.text)}\n</page>`,
				)
				.join("\n\n");
			const { text, usage, model } = await summarize(
				content,
				params.query,
				ctx,
				signal ?? undefined,
			);
			const sources = pages
				.map((p) => `- ${p.title}: ${p.url} [${p.renderer}]`)
				.join("\n");
			const failedNote = failures.length
				? `\nFailed pages:\n${failures.map((f) => `- ${f}`).join("\n")}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `${text}\n\n---\nSummary by ${model} · Search engine: ${engine}\nSources:\n${sources}${failedNote}`,
					},
				],
				details: { engine, results, pages, failures },
				usage,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page with a real browser renderer (falls back to plain HTTP) and return its text content (truncated to 50KB). Pass question to get an LLM summary focused on it.",
		promptSnippet: "Fetch a rendered web page as text, optional LLM summary",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			question: Type.Optional(
				Type.String({ description: "Focus question for an LLM summary" }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${params.url}` }],
				details: {},
			});
			const { text, renderer } = await renderPage(params.url, {
				timeoutMs: PER_PAGE_TIMEOUT_MS,
				prefer: resolveRenderer(),
				...(signal ? { signal } : {}),
			});
			if (!params.question) {
				return {
					content: [
						{ type: "text", text: `[renderer: ${renderer}]\n${truncate(text)}` },
					],
					details: { url: params.url, renderer },
				};
			}
			onUpdate?.({
				content: [{ type: "text", text: "Summarizing..." }],
				details: {},
			});
			const summary = await summarize(
				capForSummary(text),
				params.question,
				ctx,
				signal ?? undefined,
			);
			return {
				content: [
					{
						type: "text",
						text: `${summary.text}\n\n---\nSummary by ${summary.model} · renderer: ${renderer}\nSource: ${params.url}`,
					},
				],
				details: { url: params.url, renderer },
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
