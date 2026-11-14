let saveTimeout = null;

function isValidInt(v, min = -Infinity) {
	return Number.isFinite(v) && Number.isInteger(v) && v >= min;
}
function isValidFloat(v, min = -Infinity, max = Infinity) {
	return Number.isFinite(v) && v >= min && v <= max;
}

// Optional N+ filters: empty = off (key removed), otherwise integer >= 2.
// Returns false if a value is invalid.
const FILTER_FIELDS = ["hideStampsMinTimestamps", "hideOverlaysMinTimestamps"];

function collectFilterFields(payload, removals) {
	for (const id of FILTER_FIELDS) {
		const raw = document.getElementById(id).value;
		if (raw === "") {
			removals.push(id);
			continue;
		}
		const v = parseInt(raw, 10);
		if (!isValidInt(v, 2)) return false;
		payload[id] = v;
	}
	return true;
}

// Overlay placement/size. Empty = default (key removed).
const OVERLAY_POSITIONS = [
	"top-center",
	"top-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
];

function collectAppearanceFields(payload, removals) {
	const position = document.getElementById("overlayPosition").value;
	if (position === "") removals.push("overlayPosition");
	else if (OVERLAY_POSITIONS.includes(position))
		payload.overlayPosition = position;
	else return false;

	const sizeRaw = document.getElementById("overlaySize").value;
	if (sizeRaw === "") {
		removals.push("overlaySize");
	} else {
		const v = parseInt(sizeRaw, 10);
		if (!isValidInt(v, 50) || v > 200) return false;
		payload.overlaySize = v;
	}

	// Overlay widths: default = all the same width, "fit" = each as wide as its own text
	const widthMode = document.getElementById("overlayWidthMode").value;
	if (widthMode === "") removals.push("overlayWidthMode");
	else if (widthMode === "fit") payload.overlayWidthMode = "fit";
	else return false;

	// Animation direction: default = up/down, "horizontal" = left/right
	const axis = document.getElementById("overlayAnimationAxis").value;
	if (axis === "") removals.push("overlayAnimationAxis");
	else if (axis === "horizontal") payload.overlayAnimationAxis = "horizontal";
	else return false;

	// Full screen size: empty = automatic (scales with the player)
	const fullscreenRaw = document.getElementById("fullscreenOverlaySize").value;
	if (fullscreenRaw === "") {
		removals.push("fullscreenOverlaySize");
	} else {
		const v = parseInt(fullscreenRaw, 10);
		if (!isValidInt(v, 50) || v > 400) return false;
		payload.fullscreenOverlaySize = v;
	}
	return true;
}

// Replies: default is to include them (key removed), "exclude" stores excludeReplies: true.
function collectBehaviorFields(payload, removals) {
	const value = document.getElementById("excludeReplies").value;
	if (value === "") removals.push("excludeReplies");
	else if (value === "exclude") payload.excludeReplies = true;
	else return false;
	return true;
}

// What is shown with each comment. Unchecked / default = key removed.
const DETAIL_CHECKBOXES = [
	"showLikes",
	"showReplies",
	"showPublished",
	"showBadges",
];
const AUTHOR_NAME_MODES = ["display", "both"];

function collectDetailFields(payload, removals) {
	const mode = document.getElementById("authorNameMode").value;
	if (mode === "") removals.push("authorNameMode");
	else if (AUTHOR_NAME_MODES.includes(mode)) payload.authorNameMode = mode;
	else return false;

	for (const id of DETAIL_CHECKBOXES) {
		if (document.getElementById(id).checked) payload[id] = true;
		else removals.push(id);
	}
	return true;
}

// Comment source. Defaults (Innertube, scan limit applies) are stored as an absent key.
function collectSourceFields(payload, removals) {
	const backend = document.getElementById("fetchBackend").value;
	if (backend === "") removals.push("fetchBackend");
	else if (backend === "dataApi") payload.fetchBackend = "dataApi";
	else return false;

	if (document.getElementById("unlimitedScan").checked)
		payload.unlimitedScan = true;
	else removals.push("unlimitedScan");

	const sort = document.getElementById("commentSort").value;
	if (sort === "") removals.push("commentSort");
	else if (sort === "newest" || sort === "both") payload.commentSort = sort;
	else return false;

	// Data API quota one video may spend: empty = no cap
	const budgetRaw = document.getElementById("quotaBudget").value;
	if (budgetRaw === "") {
		removals.push("quotaBudget");
	} else {
		const v = parseInt(budgetRaw, 10);
		if (!isValidInt(v, 10)) return false;
		payload.quotaBudget = v;
	}

	// Experimental timestamp search: off = key removed
	if (document.getElementById("dataApiSearch").checked)
		payload.dataApiSearch = true;
	else removals.push("dataApiSearch");

	// How long a finished scan is kept: empty = the default (1 day)
	const ttl = document.getElementById("cacheTtl").value;
	if (ttl === "") removals.push("cacheTtl");
	else if (CACHE_TTL_VALUES.includes(ttl)) payload.cacheTtl = ttl;
	else return false;
	return true;
}

const CACHE_TTL_VALUES = ["off", "1h", "6h", "1w"];
// Same names as background/cache.js (this page cannot import it)
const CACHE_PREFIX = "scanCache:";
const CACHE_INDEX_KEY = "scanCacheIndex";

// The API key is a secret: it goes to storage.local so it is never synced to other devices.
async function persistLocalFields() {
	const key = document.getElementById("dataApiKey").value.trim();
	if (key) await browser.storage.local.set({ dataApiKey: key });
	else await browser.storage.local.remove("dataApiKey");
}

function syncSourceControls() {
	const dataApi = document.getElementById("fetchBackend").value === "dataApi";
	for (const card of document.querySelectorAll(".data-api-only")) {
		card.style.display = dataApi ? "" : "none";
	}
	document.getElementById("maxResults").disabled =
		document.getElementById("unlimitedScan").checked;
}

const STOP_TEXT = {
	end: "reached the end of the comments",
	limit: "stopped at the scan limit",
	budget: "stopped at the quota budget",
	aborted: "stopped because you left the video",
	error: "stopped by an error",
};

const fmt = (n) => Number(n).toLocaleString("en");

function ageText(ms) {
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function describeFetchStatus(status, now = Date.now()) {
	if (!status || typeof status !== "object") return "";
	const search = status.mode === "search";
	let head = `Last scan: ${status.backend === "dataApi" ? "Data API" : "Innertube"}`;
	if (search) head += " timestamp search";
	else if (status.sort === "both") head += " (Top + Newest)";
	else if (status.sort === "newest") head += " (Newest)";
	const parts = [head];
	if (status.fromCache && status.cachedAt)
		parts.push(`from a saved scan (${ageText(now - status.cachedAt)})`);
	parts.push(`${fmt(status.scanned ?? 0)} comments scanned`);
	// the total counts replies too, so it is only context, not a percentage
	if (Number.isFinite(status.total))
		parts.push(
			`the video has about ${fmt(status.total)} in total, with replies`,
		);
	if (search && status.termsTotal)
		parts.push(
			`searched ${fmt(status.termsSearched)} of ${fmt(status.termsTotal)} timestamps`,
		);
	parts.push(`${fmt(status.timestamps ?? 0)} timestamps found`);
	if (!status.fromCache && status.backend === "dataApi" && status.units > 0) {
		parts.push(
			`${fmt(status.units)} quota units${status.quotaBudget ? ` of ${fmt(status.quotaBudget)}` : ""}`,
		);
	}
	if (status.fromCache && status.savedUnits)
		parts.push(
			`this visit cost no quota (the scan itself cost ${fmt(status.savedUnits)} units)`,
		);
	if (STOP_TEXT[status.stopped]) parts.push(STOP_TEXT[status.stopped]);
	if (status.error) parts.push(`(${status.error})`);
	let text = parts.join(" · ");
	if (status.requestedSort === "newest" && status.sort === "top")
		text +=
			" — Newest first was not available from YouTube for this video, so Top comments were scanned.";
	if (
		status.requestedSort === "both" &&
		status.sort === "top" &&
		!search &&
		(status.stopped === "limit" || status.stopped === "budget")
	)
		text +=
			" — Newest first was not available from YouTube for this video, so only the Top half was scanned.";
	if (
		status.requestedSearch &&
		status.requestedBackend === "dataApi" &&
		!search &&
		!status.fromCache &&
		status.backend === "dataApi"
	)
		text +=
			" — Timestamp search needs the video's length, which the API did not give, so a normal scan was used.";
	if (status.missingKey)
		text +=
			" — Data API is selected but no key is saved, so Innertube was used.";
	else if (status.fellBack)
		text += ` — the Data API did not work (${status.dataApiError}), so Innertube was used.`;
	return text;
}

// "3 videos, 1.2 MB" for the Saved Scans card
async function describeCache() {
	const { [CACHE_INDEX_KEY]: index } =
		await browser.storage.local.get(CACHE_INDEX_KEY);
	const entries = Object.values(
		index && typeof index === "object" ? index : {},
	);
	if (entries.length === 0) return "Nothing saved yet.";
	const bytes = entries.reduce((sum, e) => sum + (e.bytes || 0), 0);
	const size =
		bytes >= 100 * 1024
			? `${(bytes / 1048576).toFixed(1)} MB`
			: `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `Saved: ${entries.length} video${entries.length === 1 ? "" : "s"}, about ${size}.`;
}

async function clearSavedScans() {
	const all = await browser.storage.local.get(null);
	const keys = Object.keys(all).filter(
		(k) => k.startsWith(CACHE_PREFIX) || k === CACHE_INDEX_KEY,
	);
	if (keys.length) await browser.storage.local.remove(keys);
	const count = keys.filter((k) => k.startsWith(CACHE_PREFIX)).length;
	document.getElementById("cacheStatus").textContent =
		`Cleared ${count} saved scan${count === 1 ? "" : "s"}.`;
}

async function persistFilterRemovals(removals) {
	if (removals.length) await browser.storage.sync.remove(removals);
}

function debouncedSave() {
	if (saveTimeout) clearTimeout(saveTimeout);

	saveTimeout = setTimeout(async () => {
		const payload = {};
		const removals = [];
		const maxResultsRaw = document.getElementById("maxResults").value;
		const maxConcurrentRaw = document.getElementById(
			"maxConcurrentOverlays",
		).value;
		const overlayDurationRaw = document.getElementById("overlayDuration").value;
		const overlayOpacityRaw = document.getElementById("overlayOpacity").value;

		if (maxResultsRaw !== "") {
			const v = parseInt(maxResultsRaw, 10);
			if (isValidInt(v, 1)) payload.maxResults = v;
			else return;
		} else {
			removals.push("maxResults");
		}

		if (maxConcurrentRaw !== "") {
			const v = parseInt(maxConcurrentRaw, 10);
			if (isValidInt(v, 1)) payload.maxConcurrentOverlays = v;
			else return;
		}

		if (overlayDurationRaw !== "") {
			const v = parseInt(overlayDurationRaw, 10);
			if (isValidInt(v, 1)) payload.overlayDuration = v * 1000;
			else return;
		}

		if (overlayOpacityRaw !== "") {
			const v = parseFloat(overlayOpacityRaw);
			if (isValidFloat(v, 0.1, 1)) payload.overlayOpacity = v;
			else return;
		}

		if (!collectFilterFields(payload, removals)) return;
		if (!collectAppearanceFields(payload, removals)) return;
		if (!collectBehaviorFields(payload, removals)) return;
		if (!collectDetailFields(payload, removals)) return;
		if (!collectSourceFields(payload, removals)) return;

		try {
			await persistFilterRemovals(removals);
			if (Object.keys(payload).length > 0) {
				await browser.storage.sync.set(payload);
			}
			await persistLocalFields();
		} catch (err) {}
	}, 500);
}

async function restoreOptions() {
	try {
		const keys = [
			"maxResults",
			"maxConcurrentOverlays",
			"overlayDuration",
			"overlayOpacity",
			"overlayPosition",
			"overlaySize",
			"fullscreenOverlaySize",
			"overlayWidthMode",
			"overlayAnimationAxis",
			"excludeReplies",
			"authorNameMode",
			"fetchBackend",
			"unlimitedScan",
			"commentSort",
			"quotaBudget",
			"dataApiSearch",
			"cacheTtl",
			...DETAIL_CHECKBOXES,
			...FILTER_FIELDS,
		];
		const items = await browser.storage.sync.get(keys);
		const local = await browser.storage.local.get([
			"dataApiKey",
			"lastFetchStatus",
		]);
		document.getElementById("fetchBackend").value =
			items.fetchBackend === "dataApi" ? "dataApi" : "";
		document.getElementById("unlimitedScan").checked =
			items.unlimitedScan === true;
		document.getElementById("commentSort").value =
			items.commentSort === "newest" || items.commentSort === "both"
				? items.commentSort
				: "";
		document.getElementById("quotaBudget").value = items.quotaBudget ?? "";
		document.getElementById("dataApiSearch").checked =
			items.dataApiSearch === true;
		document.getElementById("cacheTtl").value = CACHE_TTL_VALUES.includes(
			items.cacheTtl,
		)
			? items.cacheTtl
			: "";
		document.getElementById("dataApiKey").value = local.dataApiKey ?? "";
		document.getElementById("fetchStatus").textContent = describeFetchStatus(
			local.lastFetchStatus,
		);
		document.getElementById("cacheStatus").textContent = await describeCache();
		syncSourceControls();

		if (items.hasOwnProperty("maxResults")) {
			document.getElementById("maxResults").value = items.maxResults;
		} else {
			document.getElementById("maxResults").value = "";
		}

		if (items.hasOwnProperty("maxConcurrentOverlays")) {
			document.getElementById("maxConcurrentOverlays").value =
				items.maxConcurrentOverlays;
		} else {
			document.getElementById("maxConcurrentOverlays").value = "";
		}

		if (items.hasOwnProperty("overlayDuration")) {
			document.getElementById("overlayDuration").value =
				items.overlayDuration / 1000;
		} else {
			document.getElementById("overlayDuration").value = "";
		}

		for (const id of FILTER_FIELDS) {
			document.getElementById(id).value = items.hasOwnProperty(id)
				? items[id]
				: "";
		}
		document.getElementById("overlayPosition").value =
			items.overlayPosition ?? "";
		document.getElementById("overlaySize").value = items.overlaySize ?? "";
		document.getElementById("fullscreenOverlaySize").value =
			items.fullscreenOverlaySize ?? "";
		document.getElementById("overlayWidthMode").value =
			items.overlayWidthMode ?? "";
		document.getElementById("overlayAnimationAxis").value =
			items.overlayAnimationAxis ?? "";
		document.getElementById("excludeReplies").value = items.excludeReplies
			? "exclude"
			: "";
		document.getElementById("authorNameMode").value =
			items.authorNameMode ?? "";
		for (const id of DETAIL_CHECKBOXES) {
			document.getElementById(id).checked = items[id] === true;
		}

		const opacityEl = document.getElementById("overlayOpacity");
		const opacityValueLabel = document.getElementById("overlayOpacityValue");
		if (items.hasOwnProperty("overlayOpacity")) {
			opacityEl.value = items.overlayOpacity;
			opacityValueLabel.textContent = String(items.overlayOpacity);
		} else {
			opacityValueLabel.textContent = "unset";
		}
	} catch (err) {}
}

async function saveOptionsManual() {
	if (saveTimeout) {
		clearTimeout(saveTimeout);
		saveTimeout = null;
	}
	const payload = {};
	const removals = [];
	const maxResultsRaw = document.getElementById("maxResults").value;
	const maxConcurrentRaw = document.getElementById(
		"maxConcurrentOverlays",
	).value;
	const overlayDurationRaw = document.getElementById("overlayDuration").value;
	const overlayOpacityRaw = document.getElementById("overlayOpacity").value;

	if (maxResultsRaw !== "") {
		const v = parseInt(maxResultsRaw, 10);
		if (!isValidInt(v, 1)) return alert("Max comments must be an integer ≥ 1");
		payload.maxResults = v;
	} else {
		removals.push("maxResults");
	}
	if (maxConcurrentRaw !== "") {
		const v = parseInt(maxConcurrentRaw, 10);
		if (!isValidInt(v, 1))
			return alert("Max concurrent comments must be an integer ≥ 1");
		payload.maxConcurrentOverlays = v;
	}
	if (overlayDurationRaw !== "") {
		const v = parseInt(overlayDurationRaw, 10);
		if (!isValidInt(v, 1))
			return alert("Comment Duration must be an integer ≥ 1000 ms");
		payload.overlayDuration = v * 1000;
	}
	if (overlayOpacityRaw !== "") {
		const v = parseFloat(overlayOpacityRaw);
		if (!isValidFloat(v, 0.1, 1))
			return alert("Comment Opacity must be between 0.1 and 1");
		payload.overlayOpacity = v;
	}

	if (!collectFilterFields(payload, removals)) {
		return alert(
			"Timestamp filters must be an integer ≥ 2 (or empty to turn off)",
		);
	}
	if (!collectAppearanceFields(payload, removals)) {
		return alert(
			"Comment Size must be a whole number between 50 and 200 (50 and 400 for full screen), and Overlay Widths and Overlay Animation one of the listed choices",
		);
	}
	if (!collectBehaviorFields(payload, removals)) {
		return alert('Replies must be "Include" or "Exclude"');
	}
	if (!collectDetailFields(payload, removals)) {
		return alert("Author Name must be one of the listed choices");
	}
	if (!collectSourceFields(payload, removals)) {
		return alert(
			"Comment Source, Comment Order and Saved Scans must be one of the listed choices, and the quota budget a whole number of at least 10",
		);
	}

	try {
		await persistFilterRemovals(removals);
		if (Object.keys(payload).length > 0) {
			await browser.storage.sync.set(payload);
		}
		await persistLocalFields();
		const status = document.getElementById("status") || createStatusNode();
		status.textContent = "Options saved.";
		setTimeout(() => {
			status.textContent = "";
		}, 2000);
	} catch (err) {}
}

function createStatusNode() {
	let status = document.getElementById("status");
	if (!status) {
		status = document.createElement("div");
		status.id = "status";
		status.style.marginTop = "10px";
		document.body.appendChild(status);
	}
	return status;
}

document.addEventListener("DOMContentLoaded", () => {
	const maxResultsInput = document.getElementById("maxResults");
	const maxConcurrentInput = document.getElementById("maxConcurrentOverlays");
	const overlayDurationInput = document.getElementById("overlayDuration");
	const overlayOpacityInput = document.getElementById("overlayOpacity");
	const overlayOpacityValue = document.getElementById("overlayOpacityValue");

	restoreOptions();

	maxResultsInput.addEventListener("input", debouncedSave);
	maxResultsInput.addEventListener("change", debouncedSave);

	maxConcurrentInput.addEventListener("input", debouncedSave);
	maxConcurrentInput.addEventListener("change", debouncedSave);

	overlayDurationInput.addEventListener("input", debouncedSave);
	overlayDurationInput.addEventListener("change", debouncedSave);

	overlayOpacityInput.addEventListener("input", () => {
		overlayOpacityValue.textContent = overlayOpacityInput.value;
		debouncedSave();
	});
	overlayOpacityInput.addEventListener("change", debouncedSave);

	for (const id of [
		...FILTER_FIELDS,
		"overlayPosition",
		"overlaySize",
		"fullscreenOverlaySize",
		"overlayWidthMode",
		"overlayAnimationAxis",
		"excludeReplies",
		"authorNameMode",
		"fetchBackend",
		"dataApiKey",
		"unlimitedScan",
		"commentSort",
		"quotaBudget",
		"dataApiSearch",
		"cacheTtl",
		...DETAIL_CHECKBOXES,
	]) {
		const el = document.getElementById(id);
		el.addEventListener("input", debouncedSave);
		el.addEventListener("change", debouncedSave);
	}
	for (const id of ["fetchBackend", "unlimitedScan"]) {
		document.getElementById(id).addEventListener("change", syncSourceControls);
	}

	document
		.getElementById("clearCache")
		.addEventListener("click", clearSavedScans);

	const saveButton = document.getElementById("saveOptions");
	if (saveButton) {
		saveButton.addEventListener("click", (e) => {
			e.preventDefault();
			saveOptionsManual();
		});
	}
});
