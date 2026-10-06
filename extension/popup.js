// Session list popup: sessions registered at the bridge hub + this
// browser's tab groups. Click a group row to jump to its window/tab;
// release drops a pi session from the hub (it re-registers on next use).

function fmtAge(ts) {
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function shortCid(cid) {
	return String(cid ?? "unknown").slice(0, 8);
}

async function render(state) {
	const status = document.getElementById("status");
	const sessions = state.sessions ?? [];
	if (state.hubReady) {
		status.className = "status ok";
		status.textContent = `Hub connected · ${sessions.length} session(s)`;
	} else {
		status.className = "status";
		status.textContent = "Bridge hub not connected — no pi session running?";
	}

	const liveCids = new Set(sessions.map((s) => s.conversationId));

	const ports = document.getElementById("ports");
	for (const s of sessions) {
		const li = document.createElement("li");
		li.className = "port";
		const label = document.createElement("span");
		label.textContent =
			`${s.project ?? "unknown project"} · ${shortCid(s.conversationId)}` +
			(s.self ? " (hub)" : "");
		li.appendChild(label);
		if (!s.self) {
			const btn = document.createElement("button");
			btn.className = "release";
			btn.textContent = "release";
			btn.title =
				"Drop this session from the hub. The pi session stays alive; its next web search re-registers.";
			btn.onclick = () => {
				chrome.runtime
					.sendMessage({ type: "releaseClient", clientId: s.clientId })
					.catch(() => {});
				btn.disabled = true;
				btn.textContent = "released";
				// The hub pushes a fresh sessions list on release; re-render shortly.
				setTimeout(() => query(false), 700);
			};
			li.appendChild(btn);
		}
		ports.appendChild(li);
	}

	const list = document.getElementById("sessions");
	for (const g of state.groups) {
		let title = `pi:${shortCid(g.conversationId)}`;
		try {
			const group = await chrome.tabGroups.get(g.groupId);
			if (group.title) title = group.title;
		} catch {
			// group closed but not yet swept; keep the fallback title
		}
		const connected = liveCids.has(g.conversationId);
		const li = document.createElement("li");
		if (!connected) li.className = "stale";
		const t = document.createElement("div");
		t.className = "title";
		t.textContent = title;
		const m = document.createElement("div");
		m.className = "meta";
		m.textContent = `${connected ? "connected" : "disconnected"} · active ${fmtAge(g.lastActivity)}`;
		li.append(t, m);
		li.tabIndex = 0;
		li.setAttribute("role", "button");
		const focus = () =>
			chrome.runtime
				.sendMessage({ type: "focusGroup", groupId: g.groupId })
				// focusGroup never calls sendResponse; the port closing is not
				// an error here, so don't surface it as an unhandled rejection.
				.catch(() => {});
		li.onclick = focus;
		li.onkeydown = (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				focus();
			}
		};
		list.appendChild(li);
	}
}

function query(retry) {
	chrome.runtime.sendMessage({ type: "getState" }, (state) => {
		if (chrome.runtime.lastError || !state) {
			document.getElementById("status").textContent = "Bridge not running";
			return;
		}
		document.getElementById("sessions").replaceChildren();
		document.getElementById("ports").replaceChildren();
		render(state);
		// A cold worker answers before its hub redial finishes; ask once
		// more so a live hub is not shown as disconnected until reopen.
		if (!state.hubReady && retry) setTimeout(() => query(false), 1000);
	});
}
query(true);
