import { httpsUrl } from "./youtubei.js";

// YouTube Data API v3 backend. Same contract as youtubei.fetchComments: every parsed comment goes
// to onBatch, and the result is { scanned, stopped, error }. The difference is that nothing here
// depends on page scraping, and the only cap is the user's own quota.
//
// Request shapes (commentThreads.list: part, videoId, maxResults=100, pageToken, fields, key) match
// what CommenTime ships. Quota costs (1 unit per call, 10,000 units a day by default) and the
// "part=replies returns only a few replies per thread" limit are from the public docs as I
// remember them, not verified here.

const API = "https://www.googleapis.com/youtube/v3";
const PAGE_SIZE = 100;
const REPLY_CONCURRENCY = 3;

const COMMENT_FIELDS =
	"id,snippet(authorDisplayName,authorProfileImageUrl,authorChannelId,textDisplay,textOriginal,likeCount,publishedAt)";
const THREAD_FIELDS =
	"nextPageToken,items(id,snippet(totalReplyCount,topLevelComment(" +
	COMMENT_FIELDS +
	")),replies(comments(" +
	COMMENT_FIELDS +
	")))";
const THREAD_FIELDS_NO_REPLIES =
	"nextPageToken,items(id,snippet(totalReplyCount,topLevelComment(" +
	COMMENT_FIELDS +
	")))";
const REPLY_FIELDS = "nextPageToken,items(" + COMMENT_FIELDS + ")";

export class DataApiError extends Error {
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

// Turns an error response into one of a few codes the rest of the extension understands:
// quotaExceeded, keyInvalid, commentsDisabled, videoNotFound, forbidden, apiError
export function classifyError(status, bodyText) {
	const text = String(bodyText || "");
	if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(text))
		return "quotaExceeded";
	if (/commentsDisabled/i.test(text)) return "commentsDisabled";
	if (
		/API key not valid|API_KEY_INVALID|keyInvalid|API_KEY_HTTP_REFERRER_BLOCKED|ipRefererBlocked|API_KEY_SERVICE_BLOCKED|accessNotConfigured|has not been used in project/i.test(
			text,
		)
	)
		return "keyInvalid";
	if (/videoNotFound|notFound/i.test(text) || status === 404)
		return "videoNotFound";
	if (status === 403) return "forbidden";
	return "apiError";
}

// Exported so tests can shrink the waits. A hung request must not stall a scan that runs for
// minutes, and a passing 5xx or dropped connection must not end it.
export const net = { attempts: 3, baseMs: 600, timeoutMs: 20000 };

// Every request attempt costs 1 quota unit (commentThreads, comments and videos alike, as far as I
// know), so one meter per scan counts them all and stops the scan when the user's budget is used up.
export class BudgetError extends Error {
	constructor() {
		super("quota budget reached");
		this.code = "budget";
	}
}

function newMeter(max) {
	return { used: 0, max: Number.isFinite(max) && max > 0 ? max : Infinity };
}

async function request(path, params, key, signal, meter) {
	const url = new URL(API + path);
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined && value !== null)
			url.searchParams.set(name, value);
	}
	url.searchParams.set("key", key);

	let lastError;
	for (let attempt = 0; attempt < net.attempts; attempt++) {
		if (signal?.aborted) throw new Error("aborted");
		if (meter) {
			if (meter.used >= meter.max) throw new BudgetError();
			meter.used++;
		}
		const timeout = AbortSignal.timeout(net.timeoutMs);
		try {
			const response = await fetch(url, {
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				credentials: "omit",
			});
			if (response.ok) return await response.json();
			let body = "";
			try {
				body = await response.text();
			} catch (e) {
				// classify by status alone
			}
			const error = new DataApiError(
				classifyError(response.status, body),
				`HTTP ${response.status}`,
			);
			if (response.status < 500) throw error; // quota, key, comments off...: retrying cannot help
			lastError = error;
		} catch (e) {
			if (e instanceof DataApiError && e !== lastError) throw e;
			if (signal?.aborted) throw e;
			lastError = timeout.aborted ? new Error("request timed out") : e;
		}
		if (attempt < net.attempts - 1) await sleep(net.baseMs * 2 ** attempt);
	}
	throw lastError;
}

// "PT3M45S" -> 225. Live streams ("P0D") and anything unreadable give 0.
export function parseIsoDuration(iso) {
	const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
		iso || "",
	);
	if (!m) return 0;
	const [, d, h, min, sec] = m.map((x) => Number(x) || 0);
	return d * 86400 + h * 3600 + min * 60 + sec;
}

// Every timestamp string a comment could use for a video of this length, in the order they are
// searched: the plain form for every second first ("0:07", "1:05", "1:05:07"), then the
// zero-padded minutes people also write for the first ten minutes ("00:07", "01:05").
export function timestampStrings(duration) {
	const pad = (n) => String(n).padStart(2, "0");
	const plain = (t) =>
		t >= 3600
			? `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
			: `${Math.floor(t / 60)}:${pad(t % 60)}`;
	const out = [];
	for (let t = 0; t <= duration; t++) out.push(plain(t));
	for (let t = 0; t <= duration && t < 600; t++) out.push("0" + plain(t));
	return out;
}

// One call that gives three things: who owns the video (for the channel-owner badge), how many
// comments it has in total (for the coverage line), and how long it is (for the timestamp search).
async function lookupVideo(videoId, key, signal, meter) {
	try {
		const video = await request(
			"/videos",
			{
				part: "snippet,statistics,contentDetails",
				id: videoId,
				fields:
					"items(snippet(channelId),statistics(commentCount),contentDetails(duration))",
			},
			key,
			signal,
			meter,
		);
		const item = video.items?.[0];
		const total = Number(item?.statistics?.commentCount);
		return {
			ownerChannelId: item?.snippet?.channelId || "",
			total: Number.isFinite(total) ? total : null,
			duration: parseIsoDuration(item?.contentDetails?.duration),
		};
	} catch (e) {
		// a key, quota or budget problem will show on the first comments request just as well;
		// anything else only costs the badge, the total and the duration
		if (e instanceof BudgetError) throw e;
		if (
			e instanceof DataApiError &&
			(e.code === "keyInvalid" || e.code === "quotaExceeded")
		)
			throw e;
		if (signal?.aborted) throw e;
		return { ownerChannelId: "", total: null, duration: 0 };
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const SEARCH_CONCURRENCY = 3;
const SEARCH_PAGES_PER_TERM = 10; // a very popular timestamp's results ended after 2 pages in a real test

// Resolves to { scanned, stopped, error, sort, units, total, mode, termsSearched, termsTotal }
//   stopped: "end" | "limit" | "budget" (the unit budget ran out) | "aborted" | "error"
//   units:   quota units spent by this scan
//   total:   the video's comment count (threads + replies) when the API said, else null
//   mode:    "scan" (page through the comments) or "search" (one search per possible timestamp)
// options.searchMode is the experimental mode: instead of reading the comments in order, search for
// each possible timestamp string ("0:07", "0:08", ...) and read what comes back. It needs the video's
// length; without it the scan falls back to the normal mode.
export async function fetchComments(videoId, options = {}) {
	const {
		key,
		limit = 500,
		excludeReplies = false,
		sort = "top",
		signal,
		onBatch = () => {},
		unitBudget,
		searchMode = false,
	} = options;

	const meter = newMeter(unitBudget);
	const limiter = makeLimiter(REPLY_CONCURRENCY);
	const replyJobs = [];
	const seen = new Set(); // comment ids already handed out
	const seenThreads = new Set(); // a thread can come back from several searches
	let scanned = 0;
	let stopped = "end";
	let error = null;
	let pages = 0;
	let total = null;
	let mode = "scan";
	let termsSearched = 0;
	let termsTotal = 0;
	let budgetHitInReplies = false;
	let ownerChannelId = "";

	const emit = (comments) => {
		const fresh = comments.filter((c) => c.commentId && !seen.has(c.commentId));
		for (const c of fresh) seen.add(c.commentId);
		if (fresh.length) onBatch(fresh);
	};

	// Turns one page of threads into comments (with the replies that came inline). `extraReplies`
	// also fetches the rest of long reply threads, which costs more requests.
	const processItems = (items, extraReplies) => {
		const batch = [];
		let threads = 0;
		for (const item of items || []) {
			const top = item.snippet?.topLevelComment;
			if (!top?.snippet) continue;
			if (item.id && seenThreads.has(item.id)) continue;
			if (item.id) seenThreads.add(item.id);
			threads++;
			const replyTotal = Number(item.snippet.totalReplyCount) || 0;
			batch.push(toComment(top.id, top.snippet, replyTotal, ownerChannelId));
			if (excludeReplies || replyTotal === 0) continue;

			const inline = item.replies?.comments || [];
			for (const r of inline) {
				if (r?.snippet)
					batch.push(toComment(r.id, r.snippet, 0, ownerChannelId));
			}
			// part=replies only carries a few replies per thread; the rest need comments.list
			if (extraReplies && replyTotal > inline.length) {
				replyJobs.push(
					limiter(async () => {
						if (signal?.aborted) return;
						try {
							emit(
								await fetchAllReplies(
									item.id,
									key,
									signal,
									ownerChannelId,
									meter,
								),
							);
						} catch (e) {
							if (e instanceof BudgetError) {
								budgetHitInReplies = true;
								return;
							}
							if (!signal?.aborted && e.code !== "quotaExceeded")
								error = error || `replies: ${e.message || e}`;
							if (e.code === "quotaExceeded") error = "quotaExceeded";
						}
					}),
				);
			}
		}
		scanned += threads;
		emit(batch);
	};

	const threadFields = excludeReplies
		? THREAD_FIELDS_NO_REPLIES
		: THREAD_FIELDS;
	const threadPart = excludeReplies ? "snippet" : "snippet,replies";

	try {
		// The channel-owner badge is "this comment's author is the video's channel", which the
		// comments API does not say; the same call gives the comment total and the video's length.
		const video = await lookupVideo(videoId, key, signal, meter);
		ownerChannelId = video.ownerChannelId;
		total = video.total;

		if (searchMode && video.duration > 0) {
			// ---- experimental: one search per possible timestamp string
			mode = "search";
			const terms = timestampStrings(video.duration);
			termsTotal = terms.length;
			let nextTerm = 0;
			let halted = false;
			const worker = async () => {
				while (!halted && nextTerm < terms.length) {
					if (signal?.aborted) {
						halted = true;
						stopped = "aborted";
						return;
					}
					if (scanned >= limit) {
						halted = true;
						stopped = "limit";
						return;
					}
					const term = terms[nextTerm++];
					try {
						let pageToken;
						let termPages = 0;
						do {
							const data = await request(
								"/commentThreads",
								{
									part: threadPart,
									videoId,
									maxResults: PAGE_SIZE,
									searchTerms: term,
									textFormat: "html",
									pageToken,
									fields: threadFields,
								},
								key,
								signal,
								meter,
							);
							pages++;
							termPages++;
							processItems(data.items, false);
							pageToken = data.nextPageToken;
						} while (
							pageToken &&
							termPages < SEARCH_PAGES_PER_TERM &&
							scanned < limit &&
							!halted
						);
						termsSearched++;
					} catch (e) {
						if (e instanceof BudgetError) {
							halted = true;
							stopped = "budget";
							return;
						}
						if (signal?.aborted) {
							halted = true;
							return;
						}
						if (
							e instanceof DataApiError &&
							[
								"quotaExceeded",
								"keyInvalid",
								"commentsDisabled",
								"videoNotFound",
							].includes(e.code)
						) {
							halted = true;
							stopped = "error";
							error = e.code;
							return;
						}
						error = error || `search: ${e.message || e}`; // only this term is lost
						termsSearched++;
					}
				}
			};
			await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));
		} else {
			// ---- normal: page through the comments in the chosen order
			let pageToken;
			do {
				if (signal?.aborted) {
					stopped = "aborted";
					break;
				}
				if (scanned >= limit) {
					stopped = "limit";
					break;
				}
				const data = await request(
					"/commentThreads",
					{
						part: threadPart,
						videoId,
						maxResults: Math.min(PAGE_SIZE, limit - scanned),
						order: sort === "newest" ? "time" : "relevance",
						textFormat: "html",
						pageToken,
						fields: threadFields,
					},
					key,
					signal,
					meter,
				);
				pages++;
				processItems(data.items, true);
				pageToken = data.nextPageToken;
			} while (pageToken);
		}
	} catch (e) {
		if (e instanceof BudgetError) {
			stopped = "budget";
		} else {
			if (pages === 0 && !(e instanceof DataApiError)) throw e; // nothing read yet: let the caller retry
			stopped = signal?.aborted ? "aborted" : "error";
			if (stopped === "error") error = e.code || e.message || String(e);
		}
	}

	await Promise.all(replyJobs);
	if (budgetHitInReplies && stopped === "end") stopped = "budget";
	if (signal?.aborted) stopped = "aborted";
	return {
		scanned,
		stopped,
		error,
		sort: mode === "search" ? "search" : sort === "newest" ? "newest" : "top",
		units: meter.used,
		total,
		mode,
		termsSearched,
		termsTotal,
	};
}

async function fetchAllReplies(
	parentId,
	key,
	signal,
	ownerChannelId = "",
	meter,
) {
	const replies = [];
	let pageToken;
	do {
		const data = await request(
			"/comments",
			{
				part: "snippet",
				parentId,
				maxResults: PAGE_SIZE,
				textFormat: "html",
				pageToken,
				fields: REPLY_FIELDS,
			},
			key,
			signal,
			meter,
		);
		for (const r of data.items || []) {
			if (r?.snippet)
				replies.push(toComment(r.id, r.snippet, 0, ownerChannelId));
		}
		pageToken = data.nextPageToken;
	} while (pageToken && !signal?.aborted);
	return replies;
}

// Same fields the Innertube parser produces. From the Data API: text with bold / italic /
// strikethrough ranges (parsed from the HTML), likes, replies, time, and the channel-owner badge.
// Not available from it: verified / artist / member badges, and custom emoji images.
function toComment(id, snippet, replyCount, ownerChannelId = "") {
	const html =
		typeof snippet.textDisplay === "string" ? snippet.textDisplay : null;
	const parsed = html !== null ? parseCommentHtml(html) : null;
	const authorChannelId = snippet.authorChannelId?.value || "";
	return {
		commentId: id,
		authorName: snippet.authorDisplayName,
		authorAvatar: httpsUrl(snippet.authorProfileImageUrl) || undefined,
		text: parsed ? parsed.text : (snippet.textOriginal ?? ""),
		styles: parsed ? parsed.styles : [],
		emojis: parsed ? parsed.emojis : [],
		channelId: authorChannelId,
		likes: compactCount(snippet.likeCount),
		replies: compactCount(replyCount),
		published: relativeTime(snippet.publishedAt),
		verified: false,
		creator: !!ownerChannelId && authorChannelId === ownerChannelId,
		artist: false,
		memberBadgeUrl: "",
		memberBadgeLabel: "",
	};
}

const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

function decodeEntities(text) {
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
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

// What the Data API sends for textFormat=html, seen for real on a test video:
//   bold <b>, italic <i>, strikethrough <del> (nested as <b><i><del>..</del></i></b>), line breaks
//   <br>, timestamps wrapped in <a href="...watch?v=ID&amp;t=15">0:15</a> (YouTube's own recognition),
//   and entities (&amp; &lt; &gt; &quot; &#39;).
// A custom emoji arrives as an EMPTY link whose href is "<channelId>/<emojiId>"
// (<a href="UCkszU2WH9gy1mb0dV-11UJg/KsIfY6..."></a>): no name and no image URL, so it cannot be shown
// and contributes no text.
// The tags s, strike, em and strong are accepted too although they were not seen. Any other tag is
// dropped and its text kept. Returns { text, styles, emojis } with the same shapes the Innertube
// parser produces (offsets are UTF-16 code units into `text`).
export function parseCommentHtml(html) {
	let text = "";
	const segments = []; // { start, end, bold, italic, strikethrough } for every stretch of text
	const emojis = [];
	let bold = 0,
		italic = 0,
		strike = 0;

	const addText = (piece) => {
		if (!piece) return;
		const start = text.length;
		text += piece;
		segments.push({
			start,
			end: text.length,
			bold: bold > 0,
			italic: italic > 0,
			strikethrough: strike > 0,
		});
	};

	for (const token of html.match(/<\/?[a-zA-Z][^<>]*>|<|[^<]+/g) || []) {
		if (token[0] !== "<") {
			addText(decodeEntities(token));
			continue;
		}
		const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>$/.exec(token);
		if (!tag) {
			addText(decodeEntities(token)); // a stray "<" that is not a tag
			continue;
		}
		const closing = tag[1] === "/";
		const name = tag[2].toLowerCase();
		const delta = closing ? -1 : 1;
		if (name === "b" || name === "strong") bold = Math.max(0, bold + delta);
		else if (name === "i" || name === "em")
			italic = Math.max(0, italic + delta);
		else if (name === "s" || name === "strike" || name === "del")
			strike = Math.max(0, strike + delta);
		else if (name === "br" && !closing) addText("\n");
		else if (name === "img" && !closing) {
			// Not seen from the API so far: if it ever sends emoji as images, keep them as emoji
			const attrs = tag[3];
			const alt = decodeEntities(
				/\balt\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] || "",
			);
			const src = httpsUrl(
				decodeEntities(/\bsrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] || ""),
			);
			const covered = alt || ":emoji:";
			const start = text.length;
			addText(covered);
			if (src)
				emojis.push({
					start,
					end: text.length,
					url: src,
					custom: /^:[^:]+:$/.test(covered),
				});
		}
	}

	// One range per stretch that has any styling, merging neighbours with identical styling
	const styles = [];
	for (const seg of segments) {
		if (!seg.bold && !seg.italic && !seg.strikethrough) continue;
		const last = styles[styles.length - 1];
		if (
			last &&
			last.end === seg.start &&
			last.bold === seg.bold &&
			last.italic === seg.italic &&
			last.strikethrough === seg.strikethrough
		) {
			last.end = seg.end;
		} else {
			styles.push({ ...seg });
		}
	}
	return { text, styles, emojis };
}

export function compactCount(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "";
	return new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(n);
}

// "10 months ago", like the text YouTube itself shows
export function relativeTime(iso, now = Date.now()) {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	const units = [
		["year", 365 * 24 * 3600],
		["month", 30 * 24 * 3600],
		["week", 7 * 24 * 3600],
		["day", 24 * 3600],
		["hour", 3600],
		["minute", 60],
	];
	for (const [name, size] of units) {
		const count = Math.floor(seconds / size);
		if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

function makeLimiter(max) {
	let active = 0;
	const queue = [];
	const next = () => {
		if (active >= max || queue.length === 0) return;
		active++;
		const { task, resolve, reject } = queue.shift();
		task()
			.then(resolve, reject)
			.finally(() => {
				active--;
				next();
			});
	};
	return (task) =>
		new Promise((resolve, reject) => {
			queue.push({ task, resolve, reject });
			next();
		});
}