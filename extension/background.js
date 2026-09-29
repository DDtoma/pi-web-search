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
			let result;
			if (msg.kind === "search") result = await handleSearch(port, msg);
			else if (msg.kind === "fetch") result = await handleFetch(port, msg);
			else if (msg.kind === "snapshot") result = await handleSnapshot(port, msg);
			else if (msg.kind === "eval") result = await handleEval(port, msg);
			else if (msg.kind === "closeGroup") result = await handleCloseGroup(port, msg);
			else throw new Error(`unknown request kind: ${msg.kind}`);
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
			// Distinguish still-loading (slow site) from complete-but-missed
			// (event race) and expose where the tab actually ended up.
			chrome.tabs.get(tabId).then(
				(tab) =>
					reject(
						new Error(
							`tab load timeout (status=${tab?.status}, url=${tab?.url})`,
						),
					),
				() => reject(new Error("tab load timeout (tab gone)")),
			);
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
		/使用 Google 服务前|继续之前|unusual traffic|recaptcha|consent\.google|before you continue/i.test(
			document.title +
				" " +
				(document.body ? document.body.textContent.slice(0, 3000) : ""),
		);
	const out = [];
	const seen = new Set();
	// Organic result titles are h3.LC20lb inside an anchor; other h3s
	// (site links etc., class D33W6b) are Google-internal navigation.
	for (const h3 of document.querySelectorAll("#rso h3.LC20lb, #search h3.LC20lb")) {
		const a = h3.closest("a[href]");
		if (!a) continue;
		const block = a.closest(".g, .MjjYud, .tF2Cxc, [data-hveid]") || a;
		const href = a.getAttribute("href") || "";
		let url = null;
		try {
			const u = new URL(href, location.origin);
			if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname)) {
				url = u.toString(); // direct external link
			} else {
				// Old redirect style: /url?q=<real url>
				const q = u.searchParams.get("q") ?? u.searchParams.get("url");
				if (q && /^https?:/.test(q)) url = q;
			}
		} catch {
			continue;
		}
		if (!url) {
			// Current layout: href is an opaque /goto?url=<encrypted blob>.
			// Recover the destination from the visible breadcrumb cite, e.g.
			// "https://github.com › earendil-works › pi". Truncated crumbs
			// ("…") are skipped — a guessed path would 404.
			const t = block.querySelector("cite")?.textContent.trim() ?? "";
			if (t && !t.includes("…")) {
				const parts = t.split(/\s*›\s*/);
				const base = /^https?:/.test(parts[0]) ? parts[0] : `https://${parts[0]}`;
				const candidate =
					parts.length > 1 ? `${base}/${parts.slice(1).join("/")}` : base;
				try {
					const u = new URL(candidate);
					if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname)) url = candidate;
				} catch {
					// not a usable URL; drop the result
				}
			}
		}
		if (!url || seen.has(url)) continue;
		seen.add(url);
		// pi-lens-ignore: prefer-dom-node-text-content-js
		let snippet = (block.innerText || "").replace(h3.textContent, "").trim();
		if (snippet.length > 300) snippet = `${snippet.slice(0, 300)}…`;
		out.push({ title: h3.textContent.trim(), url, snippet });
		if (out.length >= maxResults) break;
	}
	return { blocked, results: out };
}

// Injected. Walks the visible DOM and builds a compact structural snapshot
// as a YAML tree: containers are `- tag` items with nested lists, text runs
// are quoted scalars, interactive elements are inline `- tag[N]: "label" ->
// href` items (also tagged data-pi-ref="N" so later script injections can
// address them). Meant to guide page interaction, not to replace full-text
// extraction. Must be self-contained.
function distillPage(maxChars, maxRefs) {
	const INTERACTIVE =
		"a[href], button, input, select, textarea, summary, [role='button'], [role='link']";
	const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE"]);
	for (const el of document.querySelectorAll("[data-pi-ref]")) {
		el.removeAttribute("data-pi-ref");
	}
	let refCount = 0;
	let out = "";
	let truncated = false;

	// YAML line writer with size cap. Scalars go through JSON.stringify:
	// double-quoted JSON is valid YAML flow-scalar syntax.
	function line(s) {
		if (truncated) return;
		if (out.length + s.length + 1 > maxChars) {
			truncated = true;
			out += "\n# …truncated";
			return;
		}
		out += `${out ? "\n" : ""}${s}`;
	}
	function visible(el) {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}
	function label(el) {
		return (
			el.getAttribute("aria-label") ||
			// pi-lens-ignore: prefer-dom-node-text-content-js
			el.innerText ||
			// image links/buttons: the picture is the label
			el.querySelector("img[alt]")?.getAttribute("alt") ||
			// form controls: <label for> association
			el.labels?.[0]?.textContent ||
			el.value ||
			el.getAttribute("placeholder") ||
			el.getAttribute("name") ||
			// icon-only links often carry a title; last: vague on form controls
			el.getAttribute("title") ||
			""
		)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80);
	}
	// Phrasing-content tags: their presence doesn't break a text line. Pages
	// that wrap every word/char in spans (animated hero text etc.) must still
	// collapse into one line instead of one line per fragment.
	const PHRASING = new Set([
		"ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DFN",
		"EM", "I", "IMG", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN",
		"STRONG", "SUB", "SUP", "TIME", "U", "VAR", "WBR",
	]);
	// Semantic containers keep their level even with a single child; other
	// single-child wrappers collapse upward or the tree drowns in divs.
	const SEMANTIC = new Set([
		"NAV", "HEADER", "MAIN", "ASIDE", "FOOTER", "SECTION", "ARTICLE",
		"FORM", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR",
		"DETAILS", "DIALOG", "FIELDSET", "FIGURE",
	]);
	// Node shapes: { t, h? } text run (h = heading tag); { tag, ref, ... }
	// interactive element; { tag, kids } container.
	function build(el) {
		const nodes = [];
		let buf = "";
		const flush = () => {
			const t = buf.replace(/\s+/g, " ").trim();
			if (t) nodes.push({ t });
			buf = "";
		};
		for (const k of el.childNodes) {
			if (k.nodeType === Node.TEXT_NODE) {
				buf += ` ${k.nodeValue}`;
				continue;
			}
			if (k.nodeType !== Node.ELEMENT_NODE) continue;
			const c = k;
			if (SKIP.has(c.tagName) || !visible(c)) continue;
			if (c.matches(INTERACTIVE)) {
				flush();
				if (refCount < maxRefs) {
					c.setAttribute("data-pi-ref", String(refCount));
					nodes.push({
						tag: c.tagName.toLowerCase(),
						ref: refCount,
						type: c.getAttribute("type") || undefined,
						l: label(c) || undefined,
						href: c.getAttribute("href")?.slice(0, 120) || undefined,
					});
					refCount++;
				}
				continue;
			}
			if (PHRASING.has(c.tagName)) {
				// pi-lens-ignore: prefer-dom-node-text-content-js
				buf += ` ${c.innerText || ""}`;
				continue;
			}
			flush();
			if (/^H[1-6]$/.test(c.tagName)) {
				// pi-lens-ignore: prefer-dom-node-text-content-js
				const t = (c.innerText || "").replace(/\s+/g, " ").trim();
				if (t) nodes.push({ t, h: c.tagName.toLowerCase() });
				continue;
			}
			const kids = build(c);
			if (kids.length === 0) continue;
			if (kids.length === 1 && !SEMANTIC.has(c.tagName)) {
				// Single-child wrapper chain: lift the child, drop the level.
				nodes.push(kids[0]);
			} else {
				nodes.push({ tag: c.tagName.toLowerCase(), kids });
			}
		}
		flush();
		return nodes;
	}
	function emit(nodes, depth) {
		for (const n of nodes) {
			if (truncated) return;
			const pad = "  ".repeat(depth);
			if (n.t != null) {
				line(`${pad}- ${n.h ? `${n.h}: ` : ""}${JSON.stringify(n.t)}`);
			} else if (n.ref != null) {
				let s = `${pad}- ${n.tag}[${n.ref}]`;
				if (n.type) s += ` type=${n.type}`;
				if (n.l) s += `: ${JSON.stringify(n.l)}`;
				if (n.href) s += ` -> ${n.href}`;
				line(s);
			} else {
				line(`${pad}- ${n.tag}`);
				emit(n.kids, depth + 1);
			}
		}
	}
	if (document.body && visible(document.body)) emit(build(document.body), 0);
	return {
		url: location.href,
		title: document.title,
		snapshot: out,
		refs: refCount,
	};
}

// Injected into fetched pages. Must be self-contained.
function extractPageText(maxLen) {
	const root =
		document.querySelector("article, main, [role='main']") || document.body;
	// innerText is the point: visible, layout-aware text without hidden nodes.
	// pi-lens-ignore: prefer-dom-node-text-content-js
	let text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
	if (text.length > maxLen) text = `${text.slice(0, maxLen)}\n[…truncated]`;
	// location.href is the post-redirect URL; the caller reports it so the
	// pi side can match this tab later for outline/eval.
	return { url: location.href, title: document.title, text };
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
	// blocked is only diagnostic for the empty case: phrases like "继续之前"
	// appear in normal zh-CN snippets, so a page that yielded results is
	// never anti-bot no matter what its body text contains.
	if (!result?.results?.length) {
		if (result?.blocked) throw new Error("Google served an anti-bot page");
		throw new Error("no parseable results");
	}
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

async function loadPageTab(record, url) {
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
	return tab.id;
}

async function fetchOne(record, url, question) {
	const tabId = await loadPageTab(record, url);
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId },
		func: extractPageText,
		args: [MAX_PAGE_TEXT],
	});
	let text = result?.text ?? "";
	let summarized = false;
	if (question && text) {
		const summary = await summarizeInExtension(text, question);
		if (summary != null) {
			text = summary;
			summarized = true;
		}
	}
	return { url: result?.url ?? url, text: `[${result?.title ?? ""}]\n${text}`, summarized };
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

// A snapshot of a URL the group already loaded (fetch keeps its tabs open)
// costs no navigation and reflects the page's current live state — reuse
// that tab. Only exact URL matches count; redirects change tab.url, so a
// redirected fetch falls through to a fresh load.
async function findGroupTabByUrl(record, url) {
	for (const id of [record.scratchTabId, ...record.fetchTabIds]) {
		if (id == null) continue;
		try {
			const tab = await chrome.tabs.get(id);
			if (tab.url === url) return id;
		} catch {
			// tab closed by the user; keep looking
		}
	}
	return null;
}

async function snapshotOne(record, url, maxChars, maxRefs) {
	const tabId =
		(await findGroupTabByUrl(record, url)) ?? (await loadPageTab(record, url));
	const [{ result }] = await chrome.scripting.executeScript({
		target: { tabId },
		func: distillPage,
		args: [maxChars, maxRefs],
	});
	if (!result) throw new Error(`${url}: could not read page`);
	return { url: result.url ?? url, title: result.title, snapshot: result.snapshot };
}

// Tabs with an attached debugger (kept attached until the tab goes away,
// so the "debugging this tab" infobar appears once per tab, not per eval).
const debuggedTabs = new Set();
chrome.debugger.onDetach.addListener(({ tabId }) => {
	debuggedTabs.delete(tabId);
});

// Run arbitrary JS in the tab that already shows `url` via the debugger
// protocol: Runtime.evaluate is exempt from the page CSP, unlike eval in
// content-script worlds. The page must have been opened by this group —
// eval never navigates.
async function handleEval(port, msg) {
	const { url, code } = msg.params ?? {};
	if (typeof url !== "string" || typeof code !== "string") {
		throw new Error("eval request missing url/code");
	}
	// Eval never navigates and never creates a group — the page must
	// already be open from an earlier search/fetch of this session.
	const record = groups[groupKey(port, msg.conversationId)];
	if (!record) throw new Error(`no open tab for ${url}`);
	const tabId = await findGroupTabByUrl(record, url);
	if (tabId == null) throw new Error(`no open tab for ${url}`);
	if (!debuggedTabs.has(tabId)) {
		try {
			await chrome.debugger.attach({ tabId }, "1.3");
		} catch (err) {
			throw new Error(
				`debugger attach failed (close DevTools on that tab and retry): ${err instanceof Error ? err.message : err}`,
			);
		}
		debuggedTabs.add(tabId);
	}
	const { result, exceptionDetails } = await chrome.debugger.sendCommand(
		{ tabId },
		"Runtime.evaluate",
		// userGesture lets page JS do gesture-gated things like window.open.
		{ expression: code, returnByValue: true, awaitPromise: true, userGesture: true },
	);
	if (exceptionDetails) {
		throw new Error(
			exceptionDetails.exception?.description ?? exceptionDetails.text,
		);
	}
	return { result: result?.value ?? null };
}

async function handleSnapshot(port, msg) {
	const { urls, maxChars = 8000, maxRefs = 200 } = msg.params ?? {};
	if (!Array.isArray(urls) || urls.length === 0) {
		throw new Error("snapshot request missing urls");
	}
	let hint = "";
	try {
		hint = new URL(urls[0]).hostname;
	} catch {
		hint = "snapshot";
	}
	const record = await ensureGroup(port, msg.conversationId, hint);
	const settled = await mapLimit(urls, 3, async (url) => {
		try {
			return { ok: true, snap: await snapshotOne(record, url, maxChars, maxRefs) };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});
	await saveGroups();
	const snapshots = [];
	const failures = [];
	for (const s of settled) {
		if (s.ok) snapshots.push(s.snap);
		else failures.push(s.error);
	}
	return { snapshots, failures };
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

// Explicit close from the agent/user — unlike closeSession notify, this
// ignores the closeGroupOnSessionEnd opt-in.
async function handleCloseGroup(port, msg) {
	if (msg.conversationId === "*") {
		// Close every group. Script-driven cleanup only — the pi tool always
		// sends its own session id and never reaches this branch.
		for (const [key, record] of Object.entries(groups)) {
			await closeGroupTabs(record.groupId);
			delete groups[key];
		}
		await saveGroups();
		return { closed: true };
	}
	let key = groupKey(port, msg.conversationId);
	if (!groups[key]) {
		// The pi instance that created the group may be dead and its port
		// since taken by another session; fall back to a conversationId-only
		// match so stale groups stay closeable.
		const suffix = `:${msg.conversationId ?? "unknown"}`;
		key = Object.keys(groups).find((k) => k.endsWith(suffix)) ?? key;
	}
	const record = groups[key];
	if (!record) return { closed: false };
	await closeGroupTabs(record.groupId);
	delete groups[key];
	await saveGroups();
	return { closed: true };
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
