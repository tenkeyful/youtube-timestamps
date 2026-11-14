import * as youtubei from "./youtubei.js";
import * as dataapi from "./dataapi.js";
import * as cache from "./cache.js";
import { getTimestampContexts } from "./timestamps.js";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.type === "fetchTimeComments") {
		fetchTimeComments(request.videoId, sender.tab?.id)
			.then(sendResponse)
			.catch((e) => {
				console.error(e);
				// Always answer, otherwise the content script waits forever and looks dead
				sendResponse(null);
			});
		return true;
	}
	if (request.type === "releaseTimeComments") {
		releaseJob(request.videoId, sender.tab?.id);
	}
	if (request.type === "keepAlive") {
		// The page sends this while a scan is unfinished. Receiving a message is what stops Firefox
		// from suspending an idle background page mid-scan (CommenTime does the same with a port),
		// and the answer lets the page notice a scan that was lost or finished without it hearing.
		const job = jobs.get(request.videoId);
		if (job) attachTab(job, sender.tab?.id);
		sendResponse({ alive: !!job, done: !!job?.done });
	}
});

const DISPLAY_NAME_CONCURRENCY = 6;
const DISPLAY_NAME_DEADLINE_MS = 4000; // never hold the comments back longer than this for names
const DISPLAY_NAME_TIMEOUT_MS = 8000; // per request
const DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const DISPLAY_NAME_FAILURE_TTL_MS = 5 * 60 * 1000;
const displayNameCache = new Map(); // channelId -> { name | null, at }

// ---- Fetch jobs -------------------------------------------------------------------------------
// A scan can take minutes (or far longer with "no limit"), so it runs as a job that outlives the
// request that started it. The page gets an answer after at most timing.firstResponseMs with whatever
// has been found so far; the job keeps going and pushes fuller snapshots to the tab as it goes.
// A finished job is kept for a while, so reopening a video costs no new requests (and, with the
// Data API, no new quota).
export const timing = {
	firstResponseMs: 15000,
	pushBaseIntervalMs: 3000,
	pushMaxIntervalMs: 20000,
	finishedJobTtlMs: 30 * 60 * 1000,
	orphanGraceMs: 60 * 1000, // nobody watching this video any more: stop after this
	keepAliveMs: 20 * 1000,
};
const STATUS_KEY = "lastFetchStatus"; // browser.storage.local, shown on the options page
const MAX_JOBS = 6;
// The experimental timestamp search spends one request per possible timestamp, so unless the user
// set a budget it gets a modest one instead of none
const DEFAULT_SEARCH_BUDGET = 500;

const jobs = new Map(); // videoId -> job

async function loadFetchSettings() {
	const sync = await browser.storage.sync.get([
		"maxResults",
		"unlimitedScan",
		"excludeReplies",
		"fetchBackend",
		"commentSort",
		"quotaBudget",
		"dataApiSearch",
		"cacheTtl",
	]);
	const local = await browser.storage.local.get(["dataApiKey"]);
	// maxResults was never given a default before, so an unset value used to fetch nothing
	const limit =
		sync.unlimitedScan === true
			? Infinity
			: Number.isInteger(sync.maxResults) && sync.maxResults >= 1
				? sync.maxResults
				: youtubei.DEFAULT_SCAN_LIMIT;
	const key =
		typeof local.dataApiKey === "string" ? local.dataApiKey.trim() : "";
	const wantsDataApi = sync.fetchBackend === "dataApi";
	const backend = wantsDataApi && key ? "dataApi" : "innertube";
	return {
		backend,
		missingKey: wantsDataApi && !key,
		key,
		limit,
		excludeReplies: !!sync.excludeReplies,
		// "top" (default), "newest", or "both" (half of the limit from each)
		sort:
			sync.commentSort === "newest" || sync.commentSort === "both"
				? sync.commentSort
				: "top",
		// quota units one scan may spend; only the Data API has quota
		quotaBudget:
			Number.isInteger(sync.quotaBudget) && sync.quotaBudget >= 10
				? sync.quotaBudget
				: null,
		searchMode: backend === "dataApi" && sync.dataApiSearch === true,
		cacheTtlMs: cache.ttlMs(sync.cacheTtl),
	};
}

// What a scan's result depends on. The API key is only part of it as a fingerprint, because this is
// also written to the persistent cache. The cache lifetime is not part of it: changing that must not
// throw saved scans away.
function settingsSignature(settings) {
	return [
		settings.backend,
		cache.fingerprint(settings.key),
		String(settings.limit),
		settings.excludeReplies,
		settings.sort,
		settings.quotaBudget,
		settings.searchMode,
	].join("|");
}

async function fetchTimeComments(videoId, tabId) {
	const settings = await loadFetchSettings();
	const signature = settingsSignature(settings);

	let job = jobs.get(videoId);
	if (job && !jobIsUsable(job, settings)) {
		discardJob(job);
		job = null;
	}
	if (!job && settings.cacheTtlMs > 0) {
		// A scan saved earlier (even before Firefox was restarted) costs no requests at all
		const record = await cache.loadCached(
			videoId,
			signature,
			settings.cacheTtlMs,
		);
		const current = jobs.get(videoId); // another request may have started one while we looked
		if (current && jobIsUsable(current, settings)) job = current;
		else if (record) job = jobFromCache(videoId, settings, record);
	}
	if (!job) job = startJob(videoId, settings);
	attachTab(job, tabId);

	await Promise.race([job.finished, sleep(timing.firstResponseMs)]);

	if (job.failed && job.entries.length === 0) {
		discardJob(job);
		return null; // the page retries later
	}
	job.firstResponseSent = true;
	return { comments: await snapshot(job), done: job.done };
}

function jobIsUsable(job, settings) {
	if (job.signature !== settingsSignature(settings)) return false;
	if (job.aborted) return false;
	if (job.failed && job.entries.length === 0) return false;
	return !job.done || Date.now() - job.finishedAt < timing.finishedJobTtlMs;
}

function makeJob(videoId, settings) {
	// Forget the oldest finished jobs so a long session does not pile up memory
	while (jobs.size >= MAX_JOBS) {
		const oldest =
			[...jobs.values()].find((j) => j.done) || jobs.values().next().value;
		discardJob(oldest);
	}
	const job = {
		videoId,
		signature: settingsSignature(settings),
		settings,
		tabs: new Set(),
		entries: [],
		stampComments: [], // the comments that have a timestamp, once each: what the cache keeps
		seen: new Set(),
		scanned: 0,
		units: 0,
		total: null,
		mode: "scan",
		termsSearched: 0,
		termsTotal: 0,
		done: false,
		failed: false,
		aborted: false,
		error: null,
		stopped: null,
		usedBackend: settings.backend,
		usedSort: null,
		fellBack: false,
		fromCache: false,
		cachedAt: 0,
		controller: new AbortController(),
		finishedAt: 0,
		firstResponseSent: false,
		orphanTimer: null,
		pushTimer: null,
		pushing: false,
		dirty: false,
		lastPushAt: 0,
	};
	jobs.set(videoId, job);
	return job;
}

function startJob(videoId, settings) {
	const job = makeJob(videoId, settings);
	job.finished = runJob(job); // never rejects
	return job;
}

// Rebuilds a finished job from a saved record: the page gets its answer at once, nothing is fetched
function jobFromCache(videoId, settings, record) {
	const job = makeJob(videoId, settings);
	for (const comment of record.comments) {
		const entries = commentToEntries(comment);
		if (!entries.length) continue; // the timestamp rules changed since it was saved
		job.entries.push(...entries);
		job.stampComments.push(comment);
		if (comment.commentId) job.seen.add(comment.commentId);
	}
	const meta = record.meta || {};
	Object.assign(job, {
		done: true,
		fromCache: true,
		cachedAt: record.savedAt,
		scanned: meta.scanned || 0,
		stopped: meta.stopped || "end",
		usedSort: meta.sort || null,
		usedBackend: meta.backend || settings.backend,
		total: meta.total ?? null,
		mode: meta.mode || "scan",
		termsSearched: meta.termsSearched || 0,
		termsTotal: meta.termsTotal || 0,
		units: 0, // this visit cost nothing
		savedUnits: meta.units || 0,
		finishedAt: Date.now(),
		finished: Promise.resolve(),
	});
	writeStatus(job);
	return job;
}

function unitBudgetFor(settings) {
	if (settings.quotaBudget) return settings.quotaBudget;
	return settings.searchMode ? DEFAULT_SEARCH_BUDGET : undefined;
}

// One scan with one backend. "Both orders" reads half of the limit from Top and then half from
// Newest, sharing the unit budget the same way; with no limit there is nothing to split, so it is
// just a normal scan.
async function scan(job, backend, onBatch) {
	const s = job.settings;
	const run = (extra) =>
		backend === "dataApi"
			? dataapi.fetchComments(job.videoId, {
					...s,
					unitBudget: unitBudgetFor(s),
					...extra,
					signal: job.controller.signal,
					onBatch,
				})
			: youtubei.fetchComments(job.videoId, {
					...s,
					...extra,
					signal: job.controller.signal,
					onBatch,
				});

	if (s.sort !== "both" || !Number.isFinite(s.limit) || s.searchMode) {
		return run({ sort: s.sort === "both" ? "top" : s.sort });
	}

	const budget = unitBudgetFor(s);
	const topLimit = Math.ceil(s.limit / 2);
	const first = await run({
		sort: "top",
		limit: topLimit,
		unitBudget: budget ? Math.ceil(budget / 2) : undefined,
	});
	// Only a scan that ran into its half-limit or half-budget has anything left to balance. The
	// whole video read, an error, or an interruption is the final answer.
	if (first.stopped !== "limit" && first.stopped !== "budget") return first;

	const second = await run({
		sort: "newest",
		strictSort: true,
		limit: s.limit - topLimit,
		unitBudget: budget ? Math.max(1, budget - (first.units || 0)) : undefined,
	});
	const newestRead = second.sort === "newest";
	return {
		scanned: first.scanned + second.scanned,
		// when Newest was not available only half of the limit was used: say how the Top part ended
		stopped: newestRead ? second.stopped : first.stopped,
		error: first.error || second.error,
		sort: newestRead ? "both" : "top",
		units: (first.units || 0) + (second.units || 0),
		total: first.total ?? second.total ?? null,
		mode: "scan",
		termsSearched: 0,
		termsTotal: 0,
	};
}

async function runJob(job) {
	const stopKeepAlive = keepAlive();
	const onBatch = (batch) => {
		for (const comment of batch) {
			if (comment.commentId && job.seen.has(comment.commentId)) continue;
			if (comment.commentId) job.seen.add(comment.commentId);
			const entries = commentToEntries(comment);
			if (!entries.length) continue; // no timestamp: nothing to keep
			job.entries.push(...entries);
			job.stampComments.push(comment);
		}
		schedulePush(job);
	};

	try {
		let result = await scan(job, job.settings.backend, onBatch);
		// A bad key or an exhausted quota before anything was read: do the work with Innertube
		// instead of showing nothing, and say so on the options page.
		if (
			job.settings.backend === "dataApi" &&
			job.entries.length === 0 &&
			result.scanned === 0 &&
			(result.error === "keyInvalid" || result.error === "quotaExceeded")
		) {
			job.fellBack = true;
			job.usedBackend = "innertube";
			job.dataApiError = result.error;
			result = await scan(job, "innertube", onBatch);
		}
		job.scanned = result.scanned;
		job.usedSort = result.sort;
		job.stopped = result.stopped;
		job.error = result.error;
		job.units = result.units || 0;
		job.total = result.total ?? null;
		job.mode = result.mode || "scan";
		job.termsSearched = result.termsSearched || 0;
		job.termsTotal = result.termsTotal || 0;
		if (result.stopped === "aborted") job.aborted = true;
		job.done = true;
	} catch (e) {
		if (job.controller.signal.aborted) {
			job.aborted = true;
		} else {
			console.error(e);
			job.failed = true;
			job.error = String(e?.message || e);
		}
		job.done = job.entries.length > 0 && !job.aborted;
	} finally {
		stopKeepAlive();
		job.finishedAt = Date.now();
		writeStatus(job);
		saveToCache(job);
		if (job.firstResponseSent && !job.aborted) schedulePush(job, true);
	}
}

// Saves a scan that ended the way the user asked (done, at the end, the limit or the budget). An
// interrupted scan or one with any error, even only some reply threads, would be served as if it were
// complete, so those are not saved. Not awaited: the page must not wait for storage.
function saveToCache(job) {
	const ttl = job.settings.cacheTtlMs;
	if (!(ttl > 0) || job.fromCache) return;
	if (!job.done || job.aborted || job.failed || job.error) return;
	cache
		.saveCached(
			{
				videoId: job.videoId,
				signature: job.signature,
				comments: job.stampComments,
				meta: {
					scanned: job.scanned,
					stopped: job.stopped,
					sort: job.usedSort,
					backend: job.usedBackend,
					total: job.total,
					units: job.units,
					mode: job.mode,
					termsSearched: job.termsSearched,
					termsTotal: job.termsTotal,
				},
			},
			ttl,
		)
		.catch(() => {});
}

function discardJob(job) {
	job.aborted = true;
	job.controller.abort();
	clearTimeout(job.pushTimer);
	clearTimeout(job.orphanTimer);
	if (jobs.get(job.videoId) === job) jobs.delete(job.videoId);
}

function attachTab(job, tabId) {
	if (typeof tabId === "number") job.tabs.add(tabId);
	clearTimeout(job.orphanTimer);
	job.orphanTimer = null;
}

function releaseJob(videoId, tabId) {
	const job = jobs.get(videoId);
	if (!job) return;
	job.tabs.delete(tabId);
	maybeOrphan(job);
}

// Nobody is looking at this video: let a running scan go on briefly (people bounce between videos
// and back), then stop it rather than keep spending requests or quota on it.
function maybeOrphan(job) {
	if (job.done || job.tabs.size > 0 || job.orphanTimer) return;
	job.orphanTimer = setTimeout(() => {
		if (!job.done && job.tabs.size === 0) discardJob(job);
	}, timing.orphanGraceMs);
}

// ---- Progressive updates ----------------------------------------------------------------------
function schedulePush(job, final = false) {
	if (!job.firstResponseSent || job.tabs.size === 0) return;
	if (job.pushTimer) return;
	const interval = Math.min(
		timing.pushMaxIntervalMs,
		timing.pushBaseIntervalMs + job.entries.length * 5,
	);
	const wait = final ? 0 : Math.max(0, job.lastPushAt + interval - Date.now());
	job.pushTimer = setTimeout(() => {
		job.pushTimer = null;
		pushUpdate(job);
	}, wait);
}

async function pushUpdate(job) {
	if (job.pushing) {
		job.dirty = true;
		return;
	}
	job.pushing = true;
	try {
		job.lastPushAt = Date.now();
		const comments = await snapshot(job);
		for (const tabId of [...job.tabs]) {
			try {
				await browser.tabs.sendMessage(tabId, {
					type: "timeCommentsUpdate",
					videoId: job.videoId,
					comments,
					done: job.done,
				});
			} catch (e) {
				job.tabs.delete(tabId); // tab closed or navigated away
			}
		}
		maybeOrphan(job);
	} finally {
		job.pushing = false;
		if (job.dirty) {
			job.dirty = false;
			schedulePush(job, job.done);
		}
	}
}

// Backup only: an extension API call from inside the background. The reliable keep-alive is the
// page's own message (see the keepAlive handler above); this guess is not verified in Firefox.
function keepAlive() {
	const timer = setInterval(() => {
		browser.runtime.getPlatformInfo().catch(() => {});
	}, timing.keepAliveMs);
	return () => clearInterval(timer);
}

function writeStatus(job) {
	const status = {
		videoId: job.videoId,
		backend: job.usedBackend,
		requestedBackend: job.settings.backend,
		missingKey: job.settings.missingKey,
		fellBack: job.fellBack,
		dataApiError: job.dataApiError || null,
		limit: Number.isFinite(job.settings.limit) ? job.settings.limit : null,
		requestedSort: job.settings.sort,
		sort: job.usedSort || job.settings.sort,
		scanned: job.scanned,
		total: job.total,
		units: job.units,
		quotaBudget: job.settings.quotaBudget,
		requestedSearch: job.settings.searchMode,
		mode: job.mode,
		termsSearched: job.termsSearched,
		termsTotal: job.termsTotal,
		fromCache: job.fromCache,
		cachedAt: job.cachedAt || null,
		savedUnits: job.savedUnits || 0,
		timestamps: job.entries.length,
		stopped: job.stopped,
		error: job.error,
		at: Date.now(),
	};
	browser.storage.local.set({ [STATUS_KEY]: status }).catch(() => {});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- From comments to the entries the page uses ----------------------------------------------
function commentToEntries(comment) {
	const entries = [];
	for (const tsContext of getTimestampContexts(comment.text || "")) {
		entries.push({
			commentId: comment.commentId,
			authorAvatar: comment.authorAvatar,
			authorName: comment.authorName,
			timestamp: tsContext.timestamp,
			time: tsContext.time,
			text: tsContext.text,
			styles: comment.styles || [],
			emojis: comment.emojis || [],
			channelId: comment.channelId || "",
			likes: comment.likes || "",
			replies: comment.replies || "",
			published: comment.published || "",
			verified: !!comment.verified,
			creator: !!comment.creator,
			artist: !!comment.artist,
			memberBadgeUrl: comment.memberBadgeUrl || "",
			memberBadgeLabel: comment.memberBadgeLabel || "",
		});
	}
	return entries;
}

// What the page gets: everything found so far, minus the comments the user's N+ limits exclude,
// with display names attached when asked for.
async function snapshot(job) {
	const settings = await browser.storage.sync.get([
		"authorNameMode",
		"hideStampsMinTimestamps",
		"hideOverlaysMinTimestamps",
	]);

	// Comments with too many timestamps (chapter lists, "best moments" lists...) are dropped here,
	// before anything else is done with them.
	const kept = excludeByTimestampCount(
		job.entries.map((entry) => ({ ...entry })),
		validTimestampLimit(settings.hideStampsMinTimestamps),
		validTimestampLimit(settings.hideOverlaysMinTimestamps),
	);

	// Display names cost one request per author, so only look them up when the user asked for
	// them, and only for authors of comments that are still in.
	if (
		settings.authorNameMode === "display" ||
		settings.authorNameMode === "both"
	) {
		await addDisplayNames(kept);
	}
	return kept;
}

function validTimestampLimit(value) {
	return Number.isInteger(value) && value >= 2 ? value : null;
}

// A comment is only known to have N timestamps once its text has been read, so it has to be fetched
// first. Everything after that is what this saves: no display-name lookups for its author, nothing
// sent to the page, nothing cached there, nothing for the page to build.
//
// There are two limits (progress bar, overlays). A comment is dropped only when NEITHER surface
// wants it. A surface without a limit wants every comment; the page applies each limit separately.
function excludeByTimestampCount(timeComments, barLimit, overlayLimit) {
	if (barLimit === null || overlayLimit === null) return timeComments;

	const counts = new Map();
	for (const tc of timeComments)
		counts.set(tc.commentId, (counts.get(tc.commentId) || 0) + 1);
	return timeComments.filter((tc) => {
		const count = counts.get(tc.commentId);
		return count < barLimit || count < overlayLimit;
	});
}

async function addDisplayNames(timeComments) {
	const channelIds = [
		...new Set(timeComments.map((tc) => tc.channelId).filter(Boolean)),
	];
	if (channelIds.length === 0) return;

	// Lookups that miss the deadline keep running and fill the cache for next time
	const lookups = mapLimit(
		channelIds,
		DISPLAY_NAME_CONCURRENCY,
		getChannelDisplayName,
	);
	await Promise.race([
		lookups,
		new Promise((resolve) => setTimeout(resolve, DISPLAY_NAME_DEADLINE_MS)),
	]);

	for (const tc of timeComments) {
		const name = cachedDisplayName(tc.channelId);
		if (name) tc.displayName = name;
	}
}

function cachedDisplayName(channelId) {
	const entry = displayNameCache.get(channelId);
	if (!entry) return undefined;
	const ttl = entry.name ? DISPLAY_NAME_TTL_MS : DISPLAY_NAME_FAILURE_TTL_MS;
	return Date.now() - entry.at < ttl ? entry.name : undefined;
}

// YouTube's comment data only has the @handle. The channel's RSS feed starts with the channel
// title, which is the display name.
async function getChannelDisplayName(channelId) {
	const entry = displayNameCache.get(channelId);
	if (entry && cachedDisplayName(channelId) !== undefined) return entry.name;
	if (
		entry &&
		!entry.name &&
		Date.now() - entry.at < DISPLAY_NAME_FAILURE_TTL_MS
	)
		return null;

	let name = null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISPLAY_NAME_TIMEOUT_MS);
	try {
		const response = await fetch(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
			{ credentials: "omit", signal: controller.signal },
		);
		if (response.ok) name = parseFeedTitle(await response.text());
	} catch (e) {
		// leave name null: the handle is shown instead
	} finally {
		clearTimeout(timer);
	}
	displayNameCache.set(channelId, { name, at: Date.now() });
	return name;
}

function parseFeedTitle(xml) {
	const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(xml);
	if (!match) return null;
	let title = match[1].trim();
	const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(title);
	if (cdata) title = cdata[1];
	title = decodeXmlEntities(title).trim();
	return title || null;
}

function decodeXmlEntities(text) {
	const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
		if (body[0] === "#") {
			const code =
				body[1].toLowerCase() === "x"
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			try {
				return String.fromCodePoint(code);
			} catch (e) {
				return whole;
			}
		}
		return named[body.toLowerCase()] ?? whole;
	});
}

// Runs fn over items with at most `limit` in flight; never rejects
async function mapLimit(items, limit, fn) {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next++];
			try {
				await fn(item);
			} catch (e) {
				/* ignore */
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
}