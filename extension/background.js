// pi Web Search Bridge — MV3 service worker.
// Dials out to every pi bridge server in the port range (one WS per pi
// process), executes search/fetch requests in real tabs grouped per
// conversation. The service worker can be killed at any time; durable state
// (tab-group mapping, config) lives in storage.local.

const PORT_MIN = 17890;
const PORT_MAX = 17899;
const PROTOCOL_VERSION = 1;
const GOOGLE_MIN_INTERVAL_MS = 2500;
const TAB_LOAD_TIMEOUT_MS = 20_000;
const MAX_FETCH_TABS_PER_GROUP = 20;
const MAX_PAGE_TEXT = 30_000;
const MAX_LLM_INPUT = 20_000;
const LLM_TIMEOUT_MS = 30_000;
const SWEEP_AFTER_MS = 24 * 3600 * 1000;
const GROUP_COLORS = [
	"blue",
	"red",
	"yellow",
	"green",
	"pink",
	"purple",
	"cyan",
	"orange",
];

/** port -> { ws, ready } */
const servers = new Map();
/** key `${port}:${conversationId}` -> group record (mirror of storage) */
let groups = {};
let config = {
	llmEnabled: false,
	baseUrl: "",
	apiKey: "",
	model: "",
	closeGroupOnSessionEnd: false,
};
let colorCounter = 0;
let lastGoogleAt = 0;
let googleQueue = Promise.resolve();

// ---------- state ----------

async function loadState() {
	const s = await chrome.storage.local.get(["groups", "config", "colorCounter"]);
	groups = s.groups ?? {};
	config = { ...config, ...(s.config ?? {}) };
	colorCounter = s.colorCounter ?? 0;
}

function saveGroups() {
	return chrome.storage.local.set({ groups, colorCounter });
}

// ---------- connection ----------

async function scan() {
	for (let port = PORT_MIN; port <= PORT_MAX; port++) {
		if (!servers.has(port)) connect(port);
	}
}

function connect(port) {
	let ws;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${port}`);
	} catch {
		return;
	}
	servers.set(port, { ws, ready: false });
	ws.onopen = () => {
		ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION }));
	};
	ws.onmessage = (e) => onMessage(port, e.data);
	ws.onclose = () => {
		const entry = servers.get(port);
		if (entry && entry.ws === ws) servers.delete(port);
	};
	// 'error' is always followed by 'close'; nothing to do here.
	ws.onerror = () => {};
}

async function onMessage(port, raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	const entry = servers.get(port);
	if (!entry) return;

	if (msg.type === "ping") return; // pi-side keepalive, resets SW idle timer
	if (msg.type === "helloAck") {
		if (msg.ok) {
			entry.ready = true;
		} else {
			entry.ws.close();
		}
		return;
	}
	if (msg.type === "notify" && msg.kind === "closeSession") {
		await handleCloseSession(port, msg.conversationId);
		return;
	}
	if (msg.type === "request") {
		if (!entry.ready) return;
		try {
			const result =
				msg.kind === "search"
					? await handleSearch(port, msg)
					: await handleFetch(port, msg);
			entry.ws.send(
				JSON.stringify({ type: "response", id: msg.id, ok: true, result }),
			);
		} catch (err) {
			entry.ws.send(
				JSON.stringify({
					type: "response",
					id: msg.id,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}
}

// ---------- tab groups ----------

function groupKey(port, conversationId) {
	return `${port}:${conversationId ?? "unknown"}`;
}

async function groupExists(groupId) {
	try {
		await chrome.tabGroups.get(groupId);
		return true;
	} catch {
		return false;
	}
}

async function normalWindowId() {
	try {
		const w = await chrome.windows.getLastFocused({
			windowTypes: ["normal"],
		});
		if (w?.id != null) return w.id;
	} catch {
		// fall through to getAll
	}
	const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
	if (!wins.length || wins[0].id == null) {
		throw new Error("no normal browser window open");
	}
	return wins[0].id;
}

async function ensureGroup(port, conversationId, titleHint) {
	const key = groupKey(port, conversationId);
	const existing = groups[key];
	if (existing && (await groupExists(existing.groupId))) {
		existing.lastActivity = Date.now();
		await saveGroups();
		return existing;
	}
	delete groups[key];
	const windowId = await normalWindowId();
	const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId });
	// tabIds is non-empty, so grouping creates a new group implicitly — no
	// `create` option (not supported by some Chromium forks' API schema).
	const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
	const short = String(conversationId ?? "unknown").slice(0, 8);
	const hint = String(titleHint ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
	await chrome.tabGroups.update(groupId, {
		title: `pi:${short}·${hint}`.slice(0, 48),
		color: GROUP_COLORS[colorCounter++ % GROUP_COLORS.length],
	});
	const record = {
		groupId,
		windowId,
		conversationId,
		lastActivity: Date.now(),
		scratchTabId: tab.id,
		fetchTabIds: [],
	};
	groups[key] = record;
	await saveGroups();
	return record;
}

async function getScratchTab(record) {
	if (record.scratchTabId != null) {
		try {
			await chrome.tabs.get(record.scratchTabId);
			return record.scratchTabId;
		} catch {
			// user closed it; recreate below
		}
	}
	const tab = await chrome.tabs.create({
		url: "about:blank",
		active: false,
		windowId: record.windowId,
	});
	await chrome.tabs.group({ groupId: record.groupId, tabIds: [tab.id] });
	record.scratchTabId = tab.id;
	return tab.id;
}

// ---------- tab helpers ----------

function waitTabComplete(tabId, { checkCurrent = false } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(onUpdated);
			reject(new Error("tab load timeout"));
		}, TAB_LOAD_TIMEOUT_MS);
		function onUpdated(id, info) {
			if (id === tabId && info.status === "complete") {
				clearTimeout(timer);
				chrome.tabs.onUpdated.removeListener(onUpdated);
				resolve();
			}
		}
		chrome.tabs.onUpdated.addListener(onUpdated);
		// Only valid when the load started before this listener registered
		// (fetchOne: tabs.create with a URL). navigateTab registers before
		// tabs.update, where "complete" would describe the OLD page.
		if (!checkCurrent) return;
		chrome.tabs.get(tabId).then((tab) => {
			if (tab?.status === "complete") {
				clearTimeout(timer);
				chrome.tabs.onUpdated.removeListener(onUpdated);
				resolve();
			}
		}, () => {
			// Tab already gone (user closed it); the timeout rejects the wait.
		});
	});
}

async function navigateTab(tabId, url) {
	const done = waitTabComplete(tabId);
	// If tabs.update rejects (tab closed mid-navigation) `done` is never
	// awaited; mark its eventual timeout rejection as handled.
	done.catch(() => {});
	await chrome.tabs.update(tabId, { url });
	await done;
}

// Injected into the Google results page. Must be self-contained.
function extractGoogleResults(maxResults) {
	const blocked =
		/unusual traffic|recaptcha|consent\.google|before you continue/i.test(
			document.title +
				" " +
				(document.body ? document.body.textContent.slice(0, 3000) : ""),
		);
	const out = [];
	const seen = new Set();
	for (const a of document.querySelectorAll("#rso a[href], #search a[href]")) {
		const h3 = a.querySelector("h3");
		if (!h3) continue;
		let url;
		try {
			url = new URL(a.href);
		} catch {
			continue;
		}
		if (/(^|\.)google\.[a-z.]+$/.test(url.hostname)) continue;
		const href = url.toString();
		if (seen.has(href)) continue;
		seen.add(href);
		const block = a.closest(".g, .MjjYud, [data-hveid]") || a;
		// pi-lens-ignore: prefer-dom-node-text-content-js
		let snippet = (block.innerText || "").replace(h3.textContent, "").trim();
		if (snippet.length > 300) snippet = `${snippet.slice(0, 300)}…`;
		out.push({ title: h3.textContent.trim(), url: href, snippet });
		if (out.length >= maxResults) break;
	}
	return { blocked, results: out };
}

// Injected into fetched pages. Must be self-contained.
function extractPageText(maxLen) {
	const root =
		document.querySelector("article, main, [role='main']") || document.body;
	// innerText is the point: visible, layout-aware text without hidden nodes.
	// pi-lens-ignore: prefer-dom-node-text-content-js
	let text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
	if (text.length > maxLen) text = `${text.slice(0, maxLen)}\n[…truncated]`;
	return { title: document.title, text };
}

// ---------- Google throttle (global, serialized) ----------

function throttleGoogle() {
	const run = googleQueue.then(async () => {
		const wait = lastGoogleAt + GOOGLE_MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastGoogleAt = Date.now();
	});
	googleQueue = run.then(
		() => {},
		() => {},
	);
	return run;
}

// ---------- request handlers ----------

/** groupKey -> Promise chain serializing searches on one scratch tab */
const searchChains = new Map();

async function handleSearch(port, msg) {
	const { query, maxResults = 5 } = msg.params ?? {};
	if (!query) throw new Error("search request missing query");
	const record = await ensureGroup(port, msg.conversationId, query);
	// The scratch tab is shared per conversation, so searches must be fully
	// serialized — throttle alone would let a second navigation interrupt
	// the first search's tab load and attribute the wrong results.
	const key = groupKey(port, msg.conversationId);
	const prev = searchChains.get(key) ?? Promise.resolve();
	const run = prev.then(() => runSearch(record, query, maxResults));
	searchChains.set(
		key,
		run.then(
			() => {},
			() => {},
		),
	);
	return run;
}

async function runSearch(record, query, maxResults) {
	await throttleGoogle();
	const tabId = await getScratchTab(record);
	record.lastActivity = Date.now();
	await saveGroups();
	const num = Math.min(Math.max(maxResults, 1) * 2, 20);
	await navigateTab(
		tabId,
		`https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num}&hl=zh-CN`,
	);
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId },
		func: extractGoogleResults,
		args: [maxResults],
	});
	if (result?.blocked) throw new Error("Google served an anti-bot page");
	if (!result?.results?.length) throw new Error("no parseable results");
	return { results: result.results };
}

async function mapLimit(items, limit, fn) {
	const out = [];
	let i = 0;
	const workers = [];
	for (let w = 0; w < Math.min(limit, items.length); w++) {
		workers.push(
			(async () => {
				while (i < items.length) {
					const idx = i++;
					out[idx] = await fn(items[idx], idx);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return out;
}

async function fetchOne(record, url, question) {
	const tab = await chrome.tabs.create({
		url,
		active: false,
		windowId: record.windowId,
	});
	// Register the load listener before any further await: grouping and
	// recycling below yield to the event loop, and a fast (cached) page can
	// fire its only "complete" event in that window. The load started at
	// tabs.create, so checking the current status is valid here.
	const loaded = waitTabComplete(tab.id, { checkCurrent: true });
	try {
		await chrome.tabs.group({ groupId: record.groupId, tabIds: [tab.id] });
	} catch {
		// group may have vanished mid-request; extraction still works
	}
	record.fetchTabIds.push(tab.id);
	// Keep fetch tabs for the user to inspect; recycle the oldest beyond cap.
	while (record.fetchTabIds.length > MAX_FETCH_TABS_PER_GROUP) {
		const oldest = record.fetchTabIds.shift();
		try {
			await chrome.tabs.remove(oldest);
		} catch {
			// already closed by the user
		}
	}
	record.lastActivity = Date.now();
	try {
		await loaded;
	} catch (err) {
		throw new Error(
			`${url}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: extractPageText,
		args: [MAX_PAGE_TEXT],
	});
	let text = result?.text ?? "";
	if (question && text) {
		text = (await summarizeInExtension(text, question)) ?? text;
	}
	return { url, text: `[${result?.title ?? ""}]\n${text}` };
}

async function handleFetch(port, msg) {
	const { urls, question } = msg.params ?? {};
	if (!Array.isArray(urls) || urls.length === 0) {
		throw new Error("fetch request missing urls");
	}
	let hint = "";
	try {
		hint = new URL(urls[0]).hostname;
	} catch {
		hint = "fetch";
	}
	const record = await ensureGroup(port, msg.conversationId, hint);
	const settled = await mapLimit(urls, 3, async (url) => {
		try {
			return { ok: true, page: await fetchOne(record, url, question) };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});
	await saveGroups();
	const pages = [];
	const failures = [];
	for (const s of settled) {
		if (s.ok) pages.push(s.page);
		else failures.push(s.error);
	}
	return { pages, failures };
}

// ---------- extension-side LLM summary (opt-in) ----------

async function summarizeInExtension(text, question) {
	if (!config.llmEnabled || !config.baseUrl || !config.apiKey || !config.model) {
		return null;
	}
	const input =
		text.length > MAX_LLM_INPUT ? text.slice(0, MAX_LLM_INPUT) : text;
	try {
		const resp = await fetch(
			`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					messages: [
						{
							role: "system",
							content:
								"Summarize the web page content concisely, focused on the user's question. Preserve concrete facts, numbers, names, dates and links. Say when the page does not answer the question.",
						},
						{
							role: "user",
							content: `Question: ${question}\n\n<page>\n${input}\n</page>`,
						},
					],
					max_tokens: 1024,
					stream: false,
				}),
				signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
			},
		);
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		const data = await resp.json();
		return data?.choices?.[0]?.message?.content ?? null;
	} catch (err) {
		// Fall back to raw page text, but not silently: a misconfigured
		// endpoint would otherwise look like a working summary.
		console.error(
			`web-search: LLM summary failed (${err instanceof Error ? err.message : String(err)}), using raw page text`,
		);
		return null;
	}
}

// ---------- session close & sweeper ----------

async function closeGroupTabs(groupId) {
	const tabs = await chrome.tabs.query({});
	const ids = tabs.filter((t) => t.groupId === groupId).map((t) => t.id);
	if (ids.length) {
		try {
			await chrome.tabs.remove(ids);
		} catch {
			// some tabs may already be gone
		}
	}
}

async function handleCloseSession(port, conversationId) {
	const key = groupKey(port, conversationId);
	const record = groups[key];
	if (!record) return;
	// Default: keep the group so the user can revisit the pages. Only close
	// when the user opted in; the sweeper recycles stale groups either way.
	if (config.closeGroupOnSessionEnd) {
		await closeGroupTabs(record.groupId);
		delete groups[key];
		await saveGroups();
	}
}

async function sweep() {
	const now = Date.now();
	let changed = false;
	for (const [key, record] of Object.entries(groups)) {
		if (!(await groupExists(record.groupId))) {
			delete groups[key];
			changed = true;
			continue;
		}
		if (now - record.lastActivity > SWEEP_AFTER_MS) {
			await closeGroupTabs(record.groupId);
			delete groups[key];
			changed = true;
		}
	}
	if (changed) await saveGroups();
}

// ---------- lifecycle ----------

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.config) {
		config = { ...config, ...(changes.config.newValue ?? {}) };
	}
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "rescan") scan();
	else if (alarm.name === "sweep") sweep();
});

chrome.runtime.onStartup.addListener(() => scan());
chrome.runtime.onInstalled.addListener(() => scan());

loadState().then(() => {
	scan();
	// Rescan keeps reconnecting after pi restarts or this worker was killed.
	// Sweep recycles tab groups whose pi session died without a shutdown.
	chrome.alarms.create("rescan", { periodInMinutes: 1 });
	chrome.alarms.create("sweep", { periodInMinutes: 60 });
});
