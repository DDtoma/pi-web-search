import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { RendererName } from "./render.ts";
import { uuidv7 } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search.json");

export type Config = {
	/** provider/id, e.g. "minimax-cn/MiniMax-M3" */
	summaryModel?: string;
	/** Thinking level for the summary call, e.g. "high" */
	summaryThinking?: ThinkingLevel;
	/** How many search results to fetch pages for (default 5, max 10) */
	fetchCount?: number;
	/** Rendering backend: "auto" | "webview" | "cdp" | "fetch" */
	renderer?: RendererName;
};

export function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH))
			return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
	} catch {}
	return {};
}

export function saveConfig(config: Config) {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export const DEFAULT_SUMMARY_MODEL = "minimax-cn/MiniMax-M3";
const DEFAULT_THINKING: ThinkingLevel = "high";
export const DEFAULT_FETCH_COUNT = 5;
export const MAX_FETCH_COUNT = 10;

export function resolveFetchCount(config: Config): number {
	const n = config.fetchCount ?? DEFAULT_FETCH_COUNT;
	return Math.min(Math.max(Math.floor(n), 1), MAX_FETCH_COUNT);
}

export function resolveRenderer(): RendererName {
	const ref = process.env.WEB_RENDERER ?? loadConfig().renderer;
	return ref === "webview" || ref === "cdp" || ref === "fetch" ? ref : "auto";
}

export function resolveSummaryModel(ctx: ExtensionContext) {
	const ref =
		process.env.WEB_SUMMARY_MODEL ??
		loadConfig().summaryModel ??
		DEFAULT_SUMMARY_MODEL;
	const slash = ref.indexOf("/");
	const model =
		slash > 0
			? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1))
			: undefined;
	if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	return ctx.model;
}

export function resolveSummaryThinking(): ThinkingLevel {
	const ref = process.env.WEB_SUMMARY_THINKING ?? loadConfig().summaryThinking;
	const levels: ThinkingLevel[] = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	return (levels as string[]).includes(ref ?? "")
		? (ref as ThinkingLevel)
		: DEFAULT_THINKING;
}

const SYSTEM_PROMPT = `You are a research assistant. Given a query and extracted web page contents, produce a factual, concise answer focused on the query. Preserve concrete facts, numbers, names, and dates. Note when sources conflict or when the provided contents do not answer the query. Do not include anything you cannot attribute to the provided contents.`;

export type SummaryResult = {
	text: string;
	usage: Usage;
	model: string;
};

/**
 * Stateless single-shot summarization: independent system prompt, no session
 * history, fresh sessionId per call.
 */
export async function summarize(
	content: string,
	question: string | undefined,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SummaryResult> {
	const model = resolveSummaryModel(ctx);
	if (!model) throw new Error("No model available for summarization");
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(
			`No auth configured for ${model.provider}/${model.id}. Run /web-search-model to pick another model.`,
		);
	}
	const prompt = question
		? `Query: ${question}\n\n<contents>\n${content}\n</contents>`
		: `Summarize the following web content concisely, preserving key facts, names, numbers, and links.\n\n<contents>\n${content}\n</contents>`;
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			sessionId: uuidv7(),
			cacheRetention: "none",
			reasoning: resolveSummaryThinking(),
			...(signal ? { signal } : {}),
		},
	);
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return {
		text,
		usage: response.usage,
		model: `${model.provider}/${model.id}`,
	};
}
