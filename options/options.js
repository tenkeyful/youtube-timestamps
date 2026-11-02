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

async function persistFilterRemovals(removals) {
	if (removals.length) await browser.storage.sync.remove(removals);
}

function debouncedSave() {
	if (saveTimeout) clearTimeout(saveTimeout);

	saveTimeout = setTimeout(async () => {
		const payload = {};
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

		const removals = [];
		if (!collectFilterFields(payload, removals)) return;
		if (!collectAppearanceFields(payload, removals)) return;
		if (!collectBehaviorFields(payload, removals)) return;
		if (!collectDetailFields(payload, removals)) return;

		try {
			await persistFilterRemovals(removals);
			if (Object.keys(payload).length > 0) {
				await browser.storage.sync.set(payload);
			}
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
			...DETAIL_CHECKBOXES,
			...FILTER_FIELDS,
		];
		const items = await browser.storage.sync.get(keys);

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

	const removals = [];
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

	try {
		await persistFilterRemovals(removals);
		if (Object.keys(payload).length > 0) {
			await browser.storage.sync.set(payload);
		}
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
		...DETAIL_CHECKBOXES,
	]) {
		const el = document.getElementById(id);
		el.addEventListener("input", debouncedSave);
		el.addEventListener("change", debouncedSave);
	}

	const saveButton = document.getElementById("saveOptions");
	if (saveButton) {
		saveButton.addEventListener("click", (e) => {
			e.preventDefault();
			saveOptionsManual();
		});
	}
});
