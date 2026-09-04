import { htmlToText, validateUrl, UA } from "./text.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RendererName = "auto" | "webview" | "cdp" | "fetch";

export type RenderResult = {
	/** Extracted page text */
	text: string;
	/** Name of the renderer that produced the text */
	renderer: string;
};

/**
 * A renderer turns a URL into page text. Implementations must be
 * self-contained: construct lazily, clean up after themselves, and throw on
 * failure so the caller can fall through to the next renderer.
 *
 * To replace the rendering backend, add a new Renderer to `rendererChain`
 * (or reorder it) — no other code changes needed.
 */
export interface Renderer {
	name: string;
	render(url: string, opts: RenderOpts): Promise<string>;
}

export type RenderOpts = {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Which renderer to try first; "auto" = cdp → fetch */
	prefer?: RendererName;
};

const FETCH_TIMEOUT_MS = 15_000;

class FetchRenderer implements Renderer {
	name = "fetch";
	async render(url: string, opts: RenderOpts): Promise<string> {
		const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs);
		// Follow redirects manually so every hop is re-validated — an
		// automatic follow would let a 30x bounce past validateUrl into
		// a private network.
		let current = validateUrl(url);
		let response: Response | undefined;
		for (let redirects = 0; ; redirects++) {
			response = await fetch(current, {
				headers: { "User-Agent": UA },
				signal,
				redirect: "manual",
			});
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => {});
			if (!location) break;
			if (redirects >= 10) throw new Error(`Too many redirects for ${url}`);
			current = validateUrl(new URL(location, current).toString());
		}
		if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
		const contentType = response.headers.get("content-type") ?? "";
		const body = await response.text();
		return contentType.includes("html") ? htmlToText(body) : body;
	}
}

/** Look up a browser binary on PATH (where.exe on Windows, which elsewhere).
 * Catches package-manager installs such as scoop/chocolatey shims. */
function findOnPath(names: string[]): string | null {
	const tool = process.platform === "win32" ? "where.exe" : "which";
	for (const name of names) {
		try {
			const out = execFileSync(tool, [name], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			const first = out.split(/\r?\n/)[0];
			if (first && existsSync(first)) return first;
		} catch {
			// not on PATH — try the next name
		}
	}
	return null;
}

function findChrome(): string {
	if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
		return process.env.CHROME_PATH;
	}
	const candidates: string[] = [];
	if (process.platform === "win32") {
		const prefixes = [
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		];
		for (const base of prefixes) {
			if (base)
				candidates.push(join(base, "Google/Chrome/Application/chrome.exe"));
		}
		// Edge is preinstalled on Windows 10+ and speaks CDP — last-resort fallback
		for (const base of [
			process.env["PROGRAMFILES(X86)"],
			process.env.PROGRAMFILES,
		]) {
			if (base)
				candidates.push(join(base, "Microsoft/Edge/Application/msedge.exe"));
		}
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		);
	} else {
		candidates.push(
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
		);
	}
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	const onPath = findOnPath(
		process.platform === "win32"
			? ["chrome.exe", "chrome", "chromium", "msedge.exe"]
			: ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"],
	);
	if (onPath) return onPath;
	throw new Error("No Chrome/Chromium binary found (set CHROME_PATH)");
}

type CdpMessage = {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message: string };
};

/** Minimal CDP client over a page-level WebSocket (Node built-in WebSocket). */
class CdpConnection {
	private ws: WebSocket;
	private nextId = 0;
	private closed = false;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private onceHandlers = new Map<
		string,
		Array<{ resolve: (params: unknown) => void; reject: (e: Error) => void }>
	>();
	private listeners = new Map<string, Array<(params: unknown) => void>>();
	private opened: Promise<void>;
	private rejectOpened!: (err: Error) => void;

	constructor(wsUrl: string) {
		this.ws = new WebSocket(wsUrl);
		this.opened = new Promise((resolve, reject) => {
			this.rejectOpened = reject;
			this.ws.addEventListener("open", () => resolve(), { once: true });
			this.ws.addEventListener(
				"error",
				() => reject(new Error("CDP WebSocket error")),
				{ once: true },
			);
			// After close() the socket reports "close", not "error" — without
			// this a close during CONNECTING would leave opened pending
			// forever and any send() awaiting it would hang.
			this.ws.addEventListener(
				"close",
				() => reject(new Error("CDP WebSocket closed before open")),
				{ once: true },
			);
		});
		// close() can reject opened before any send() awaits it; pre-attach
		// a handler so that path is never an unhandled rejection. Awaiting
		// the original promise in send() still rejects as usual.
		this.opened.catch(() => {});
		this.ws.addEventListener("message", (ev) => {
			let msg: CdpMessage;
			try {
				msg = JSON.parse(String(ev.data)) as CdpMessage;
			} catch {
				return; // not JSON — not a CDP message, ignore
			}
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method) {
				const once = this.onceHandlers.get(msg.method);
				if (once?.length) {
					this.onceHandlers.delete(msg.method);
					for (const h of once) h.resolve(msg.params);
				}
				const ls = this.listeners.get(msg.method);
				if (ls) for (const l of ls) l(msg.params);
			}
		});
	}

	async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		await this.opened;
		if (this.closed) throw new Error("CDP connection closed");
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Resolves on the next occurrence of the event. Register before triggering.
	 * Rejects if the connection closes first, so waiters never hang. */
	once(method: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new Error("CDP connection closed"));
				return;
			}
			const handlers = this.onceHandlers.get(method) ?? [];
			handlers.push({ resolve, reject });
			this.onceHandlers.set(method, handlers);
		});
	}

	/** Persistent event subscription (e.g. Fetch.requestPaused). The handler
	 * must never throw — rejections inside it are the caller's problem. */
	on(method: string, handler: (params: unknown) => void) {
		const ls = this.listeners.get(method) ?? [];
		ls.push(handler);
		this.listeners.set(method, ls);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			// already closed
		}
		// Settle every in-flight call and event wait so async code still
		// awaiting a response unwinds immediately instead of dangling on
		// a dead socket.
		const err = new Error("CDP connection closed");
		this.rejectOpened(err);
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
		for (const handlers of this.onceHandlers.values()) {
			for (const h of handlers) h.reject(err);
		}
		this.onceHandlers.clear();
		this.listeners.clear();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Kill Chrome's whole process tree synchronously (Windows) or signal the
 * main process (POSIX, where children exit with the browser process). */
function killChrome(proc: ChildProcess) {
	if (process.platform === "win32") {
		// Node's kill() only targets the main process; taskkill /t takes the
		// whole tree and waits, so profile files are unlocked before removal.
		if (proc.pid === undefined) return;
		try {
			execFileSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
				stdio: "ignore",
			});
		} catch {
			// already dead
		}
		return;
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		// already dead
	}
}

/** Sync sleep usable inside process 'exit' handlers (timers don't run there). */
function syncSleep(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rm -rf with a retry budget for Windows' transient file locks: Chrome's
 * SQLite/LevelDB handles are released a beat after the process dies, and
 * rmSync's own maxRetries does not cover EPERM on the root directory.
 * Never throws — leftovers are picked up by sweepStaleProfiles. */
function removeProfileDir(userDataDir: string, attempts = 30) {
	for (let i = 0; i < attempts; i++) {
		try {
			rmSync(userDataDir, { recursive: true, force: true });
			return;
		} catch {
			if (i + 1 < attempts) syncSleep(100);
		}
	}
}

/** Synchronous last-resort cleanup: kill Chrome and remove its profile.
 * Shared by the host-exit handler and shutdown()'s grace-period fallback. */
function forceCleanup(proc: ChildProcess, userDataDir: string) {
	killChrome(proc);
	removeProfileDir(userDataDir);
}

/** Kill a child and its whole process tree (WebKit spawns helper
 * processes that would otherwise be orphaned by a plain kill). */
function killTree(proc: ChildProcess) {
	if (proc.pid === undefined) return;
	if (process.platform === "win32") {
		// No POSIX process groups on Windows — taskkill /t walks the tree.
		try {
			execFileSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
				stdio: "ignore",
			});
		} catch {
			// already dead
		}
		return;
	}
	try {
		process.kill(-proc.pid, "SIGKILL");
	} catch {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already dead
		}
	}
}

/** Remove CDP profile dirs older than 1h — leftovers from hosts that
 * were SIGKILLed before their exit handler could clean up. */
function sweepStaleProfiles() {
	try {
		for (const name of readdirSync(tmpdir())) {
			if (!name.startsWith("pi-web-search-cdp-")) continue;
			const dir = join(tmpdir(), name);
			try {
				if (Date.now() - statSync(dir).mtimeMs > 60 * 60 * 1000) {
					rmSync(dir, { recursive: true, force: true });
				}
			} catch {
				// raced with another process — ignore
			}
		}
	} catch {
		// tmp not readable — ignore
	}
}

const CDP_IDLE_SHUTDOWN_MS = Math.max(
	1_000,
	parseInt(process.env.WEB_CDP_IDLE_MS ?? "", 10) || 5 * 60 * 1000,
);

/**
 * Renders pages in headless Chrome driven directly over the DevTools
 * Protocol — no npm dependencies. One Chrome process is reused while in
 * use and shut down after 5 minutes idle; each render is a separate
 * target (tab) that is closed when the render finishes.
 */
class CdpRenderer implements Renderer {
	name = "cdp";
	private browser: Promise<{
		port: number;
		proc: ChildProcess;
		userDataDir: string;
	}> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	private touch() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.shutdown(), CDP_IDLE_SHUTDOWN_MS);
		this.idleTimer.unref();
	}

	private async shutdown() {
		const pending = this.browser;
		this.browser = null;
		if (!pending) return;
		const b = await pending.catch(() => null);
		if (!b) return;
		b.proc.kill("SIGTERM");
		await Promise.race([
			new Promise((r) => b.proc.once("exit", r)),
			sleep(3_000).then(() => killChrome(b.proc)),
		]);
		// Async variant of removeProfileDir's retry loop — same Windows
		// transient-lock rationale, without blocking the event loop.
		for (let i = 0; i < 30; i++) {
			try {
				rmSync(b.userDataDir, { recursive: true, force: true });
				break;
			} catch {
				await sleep(100);
			}
		}
	}

	private ensureBrowser(): Promise<{
		port: number;
		proc: ChildProcess;
		userDataDir: string;
	}> {
		if (this.browser) return this.browser;
		const launching = (async () => {
			sweepStaleProfiles();
			const userDataDir = mkdtempSync(join(tmpdir(), "pi-web-search-cdp-"));
			const proc = spawn(
				findChrome(),
				[
					"--headless=new",
					"--remote-debugging-port=0",
					`--user-data-dir=${userDataDir}`,
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-gpu",
					"--no-sandbox",
					"--disable-dev-shm-usage",
					"about:blank",
				],
				{ stdio: "ignore" },
			);
			// Register cleanup before the port poll: a failed launch (Chrome never
			// writes DevToolsActivePort, or spawn races) would otherwise leak the
			// mkdtempSync dir, since this handler is the only thing that rmSyncs it.
			process.once("exit", () => forceCleanup(proc, userDataDir));
			// Chrome writes "<port>\n<ws-path>" to DevToolsActivePort once ready.
			const portFile = join(userDataDir, "DevToolsActivePort");
			let port = 0;
			for (let i = 0; i < 80; i++) {
				try {
					port = parseInt(readFileSync(portFile, "utf8").split("\n")[0] ?? "", 10);
					if (port > 0) break;
				} catch {
					// DevToolsActivePort not written yet — keep polling
				}
				await sleep(100);
			}
			if (!port) {
				proc.kill("SIGKILL");
				throw new Error("Chrome did not expose a DevTools port in time");
			}
			proc.once("exit", () => {
				// Only clear if this promise is still the current browser — a
				// stale exit must not wipe a newer browser's promise.
				if (this.browser === launching) this.browser = null;
			});
			return { port, proc, userDataDir };
		})();
		this.browser = launching;
		launching.catch(() => {
			if (this.browser === launching) this.browser = null;
		});
		return launching;
	}

	async render(url: string, opts: RenderOpts): Promise<string> {
		validateUrl(url);
		if (opts.signal?.aborted) throw new Error("aborted");
		this.touch();
		const { port } = await this.ensureBrowser();
		const create = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
			method: "PUT",
		});
		if (!create.ok)
			throw new Error(`CDP target create failed: HTTP ${create.status}`);
		const target = (await create.json()) as {
			id: string;
			webSocketDebuggerUrl: string;
		};
		const cdp = new CdpConnection(target.webSocketDebuggerUrl);
		// No Promise.race: timeout/abort close the connection, which rejects
		// every in-flight send/once and unwinds the flow through the normal
		// await chain — no orphaned promises, no unhandled rejections.
		let timedOut = false;
		let succeeded = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			cdp.close();
		}, opts.timeoutMs);
		timeout.unref();
		const onAbort = () => cdp.close();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		// The entry check ran before the awaits above — an abort landing in
		// that window would never fire the listener, so re-check after
		// subscribing.
		if (opts.signal?.aborted) onAbort();
		// Chrome follows redirects on its own, so per-request interception is
		// the only way to keep private-network hosts out of the fetched page.
		let docBlockError: Error | null = null;
		cdp.on("Fetch.requestPaused", (params) => {
			const p = params as {
				requestId: string;
				resourceType?: string;
				request: { url: string };
			};
			void (async () => {
				let blockErr: Error | null = null;
				try {
					const u = new URL(p.request.url);
					// Only http(s) goes through validateUrl; data:/blob:/about:
					// subresources pass through untouched.
					if (u.protocol === "http:" || u.protocol === "https:") {
						validateUrl(p.request.url);
					}
				} catch (err) {
					blockErr = err instanceof Error ? err : new Error(String(err));
				}
				if (blockErr && p.resourceType === "Document") {
					// A blocked main-frame navigation (initial URL or redirect
					// hop) can never produce usable text — fail fast instead of
					// waiting out the render timeout.
					docBlockError ??= blockErr;
					cdp.close();
					return;
				}
				try {
					if (blockErr) {
						await cdp.send("Fetch.failRequest", {
							requestId: p.requestId,
							errorReason: "BlockedByClient",
						});
					} else {
						await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
					}
				} catch {
					// connection closed mid-intercept — render is already unwinding
				}
			})();
		});
		try {
			await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
			await cdp.send("Page.enable");
			const loaded = cdp.once("Page.loadEventFired");
			// If the connection dies while Page.navigate is still in flight,
			// both are rejected and the navigate rejection wins the await
			// chain — mark loaded handled up front so it never surfaces as
			// an unhandled rejection.
			void loaded.catch(() => {});
			await cdp.send("Page.navigate", { url });
			await loaded;
			// Wait for client-side rendering to settle: poll body text
			// until it stops growing (networkidle proxy, ~6s cap).
			let text = "";
			let lastLen = -1;
			let stable = 0;
			for (let i = 0; i < 12; i++) {
				await sleep(500);
				const result = await cdp.send<{ result: { value?: string } }>(
					"Runtime.evaluate",
					{
						expression: EXTRACT_EXPRESSION,
						returnByValue: true,
					},
				);
				text = result.result.value ?? "";
				if (text.length === lastLen) {
					if (++stable >= 2) break;
				} else {
					stable = 0;
					lastLen = text.length;
				}
			}
			if (!text.trim()) throw new Error(`Empty rendered body for ${url}`);
			succeeded = true;
			return text;
		} catch (err) {
			if (docBlockError) throw docBlockError;
			if (timedOut) throw new Error(`render timeout for ${url}`);
			if (opts.signal?.aborted) throw new Error("aborted");
			throw err;
		} finally {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
			cdp.close();
			await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(
				() => {},
			);
			// Only successful renders count as activity — failures must not
			// keep a wedged browser alive past its idle deadline.
			if (succeeded) this.touch();
		}
	}
}

// Extract page text. innerText reflects what is actually rendered, but
// sites using content-visibility:auto only render the viewport, making
// innerText nearly empty — in that case fall back to a cleaned clone
// (innerText on a detached node degenerates to textContent, minus
// script/style/noscript/template/svg).
const EXTRACT_EXPRESSION = `(() => {
	const body = document.body;
	if (!body) return '';
	const rendered = body.innerText;
	if (rendered.trim().length > 500) return rendered;
	const clone = body.cloneNode(true);
	for (const n of clone.querySelectorAll('script,style,noscript,template,svg')) n.remove();
	return (clone.textContent || '')
		.replace(/\\t+/g, ' ')
		.replace(/\\n{3,}/g, '\\n\\n');
})()`;

const WEBKIT_SCRIPT = fileURLToPath(
	new URL("./webkit-render.py", import.meta.url),
);

/**
 * Renders pages with WebKit2GTK (via a Python helper process) — the
 * WebView rendering backend. The helper prints the extracted body text as
 * JSON on stdout; each call spawns one short-lived process.
 */
class WebViewRenderer implements Renderer {
	name = "webview";
	private available: Promise<boolean> | null = null;

	private checkAvailable(): Promise<boolean> {
		// WebKit2GTK is Linux-only; skip the python3 probe elsewhere (on
		// Windows it can hit the Store stub and misreport).
		if (process.platform !== "linux") {
			this.available ??= Promise.resolve(false);
			return this.available;
		}
		if (!this.available) {
			this.available = new Promise((resolve) => {
				const p = spawn("python3", [
					"-c",
					"import gi; gi.require_version('WebKit2','4.1'); from gi.repository import WebKit2",
				]);
				p.on("error", () => resolve(false));
				p.on("close", (code) => resolve(code === 0));
			});
		}
		return this.available;
	}

	async render(url: string, opts: RenderOpts): Promise<string> {
		validateUrl(url);
		if (!(await this.checkAvailable())) {
			throw new Error(
				"WebKit2GTK not available (python3-gi + WebKit2 4.1 required)",
			);
		}
		if (opts.signal?.aborted) throw new Error("aborted");
		// detached: new process group, so killTree can take down the
		// python helper AND its WebKit helper processes together.
		const p = spawn(
			"python3",
			[WEBKIT_SCRIPT, url, String(Math.ceil(opts.timeoutMs / 1000)), "1000"],
			{ detached: true },
		);
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		const killTimer = setTimeout(() => killTree(p), opts.timeoutMs + 5_000);
		const onAbort = () => killTree(p);
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		// Same check-then-subscribe race as CdpRenderer: an abort that
		// landed before listener registration must still kill the helper.
		if (opts.signal?.aborted) onAbort();
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				p.once("error", reject);
				p.once("close", (c) => resolve(c));
			});
			const line = stdout.trim().split("\n").pop() ?? "";
			type WebkitResult = { ok: boolean; text: string; error: string | null };
			let r: WebkitResult | null = null;
			try {
				r = JSON.parse(line) as WebkitResult;
			} catch {
				// not JSON — report below
			}
			if (r?.ok && r.text.trim()) return r.text;
			throw new Error(
				r?.error ??
					`webkit-render.py failed (exit ${code}): ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
			);
		} finally {
			clearTimeout(killTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			// Safety net: if we left via an error path while the helper is
			// still running, take the group down. No-op after natural exit.
			if (p.exitCode === null && p.signalCode === null) killTree(p);
		}
	}
}

const cdpRenderer = new CdpRenderer();
const fetchRenderer = new FetchRenderer();
const webViewRenderer = new WebViewRenderer();

/** First renderer that yields text wins; rest are fallbacks. */
function buildChain(prefer?: RendererName): Renderer[] {
	switch (prefer) {
		case "fetch":
			return [fetchRenderer];
		case "webview":
			return [webViewRenderer, cdpRenderer, fetchRenderer];
		case "cdp":
			return [cdpRenderer, fetchRenderer];
		default:
			return [cdpRenderer, fetchRenderer];
	}
}

export async function renderPage(
	url: string,
	opts?: Partial<RenderOpts>,
): Promise<RenderResult> {
	const full: RenderOpts = { timeoutMs: FETCH_TIMEOUT_MS, ...opts };
	const errors: string[] = [];
	for (const renderer of buildChain(full.prefer)) {
		try {
			const text = await renderer.render(url, full);
			return { text, renderer: renderer.name };
		} catch (err) {
			// An abort is not a renderer failure — surface it directly
			// instead of pointlessly falling through to renderers that
			// will abort too.
			if (full.signal?.aborted) throw new Error("aborted");
			errors.push(
				`${renderer.name}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	throw new Error(`All renderers failed for ${url} (${errors.join("; ")})`);
}
