async function restore() {
	const { config } = await chrome.storage.local.get("config");
	const c = config ?? {};
	document.getElementById("llmEnabled").checked = c.llmEnabled ?? false;
	document.getElementById("baseUrl").value = c.baseUrl ?? "";
	document.getElementById("apiKey").value = c.apiKey ?? "";
	document.getElementById("model").value = c.model ?? "";
	document.getElementById("closeGroupOnSessionEnd").checked =
		c.closeGroupOnSessionEnd ?? false;
}

async function save() {
	const config = {
		llmEnabled: document.getElementById("llmEnabled").checked,
		baseUrl: document.getElementById("baseUrl").value.trim(),
		apiKey: document.getElementById("apiKey").value.trim(),
		model: document.getElementById("model").value.trim(),
		closeGroupOnSessionEnd: document.getElementById("closeGroupOnSessionEnd")
			.checked,
	};
	await chrome.storage.local.set({ config });
	const status = document.getElementById("status");
	status.textContent = "已保存";
	setTimeout(() => {
		status.textContent = "";
	}, 2000);
}

document.getElementById("save").addEventListener("click", save);
restore();
