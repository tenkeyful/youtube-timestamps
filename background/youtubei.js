const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT_NAME = "WEB";
const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00";

// How many top-level comments are scanned when the user never chose a number.
export const DEFAULT_SCAN_LIMIT = 500;
const REPLY_CONCURRENCY = 4;

// Scans the video's comments (in YouTube's own order) until `limit` top-level comments have been
// read or the list ends, and hands every parsed comment to onBatch as it arrives, so the caller can
// show results long before a huge scan finishes. Replies are fetched alongside, never counted in
// `limit`, and not at all when excludeReplies is set.
//
// `sort` is "top" (YouTube's default) or "newest". Resolves to { scanned, stopped, error, sort }:
//   stopped: "end" (no more comments) | "limit" | "aborted" | "error"
//   error:   message when stopped is "error", or when only some reply threads failed
//   sort:    the order actually read; "top" when "newest" was asked for but YouTube's response had
//            no sort menu to switch with (with strictSort nothing is read then)
// Throws if nothing could be read at all (bad first response), so the caller can retry later.
export async function fetchComments(videoId, options = {}) {
	const {
		limit = DEFAULT_SCAN_LIMIT,
		excludeReplies = false,
		sort = "top",
		strictSort = false,
		signal,
		onBatch = () => {},
	} = options;

	const videoResponse = await fetchVideo(videoId, signal);
	let token = commentsContinuationToken(videoResponse);
	if (!token) {
		return { scanned: 0, stopped: "end", error: null, sort: "top" };
	}

	const limiter = makeLimiter(REPLY_CONCURRENCY);
	const replyJobs = [];
	let scanned = 0;
	let prevToken;
	let pageCount = 0;
	let stopped = "end";
	let error = null;
	let usedSort = "top";
	let sortChecked = sort !== "newest";

	try {
		while (prevToken !== token) {
			if (signal?.aborted) {
				stopped = "aborted";
				break;
			}
			if (scanned >= limit) {
				stopped = "limit";
				break;
			}
			const commentsResponse = await fetchNext(token, signal);
			prevToken = token;

			// The sort menu comes with the first page, which is in YouTube's default order. To read
			// newest-first, drop that page and continue from the menu's token for that order.
			if (!sortChecked) {
				sortChecked = true;
				const newest = findNewestSort(commentsResponse);
				if (newest.current) {
					usedSort = "newest";
				} else if (newest.token) {
					token = newest.token;
					usedSort = "newest";
					continue;
				} else if (strictSort) {
					// "Both orders" asks for Newest as a second pass; reading the default order again
					// would only fetch the same comments twice, so stop without reading anything
					return { scanned: 0, stopped: "end", error: null, sort: "top" };
				}
			}

			const mutationMap = mutationMapOf(commentsResponse);
			const items = continuationItemsOf(commentsResponse);
			if (items.length === 0) {
				// Nothing at all on the first page means the response shape was not understood:
				// fail loudly so the caller retries instead of caching "no comments"
				if (pageCount === 0) throw new Error("unexpected comments response");
				break;
			}

			const batch = [];
			for (const item of items) {
				if (item.commentThreadRenderer) {
					if (scanned + batch.length >= limit) continue;
					const comment = commentFromThread(item, mutationMap);
					if (!comment) continue;
					batch.push(comment);
					if (!excludeReplies) {
						const replyToken = extractReplyToken(item);
						if (replyToken) {
							replyJobs.push(
								limiter(async () => {
									if (signal?.aborted) return;
									try {
										const replies = await fetchReplies(replyToken, signal);
										if (replies.length) onBatch(replies);
									} catch (e) {
										if (!signal?.aborted)
											error = error || `replies: ${e.message || e}`;
									}
								}),
							);
						}
					}
				} else if (item.continuationItemRenderer) {
					token = findToken(item.continuationItemRenderer) ?? token;
				}
			}
			scanned += batch.length;
			if (batch.length) onBatch(batch);
			pageCount++;
		}
	} catch (e) {
		if (pageCount === 0) throw e;
		stopped = signal?.aborted ? "aborted" : "error";
		if (stopped === "error") error = e.message || String(e);
	}

	await Promise.all(replyJobs);
	if (signal?.aborted) stopped = "aborted";
	return { scanned, stopped, error, sort: usedSort };
}

// Runs at most `max` async tasks at once; each call resolves with its own task's result
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

// A continuation token sits in one of two places: on the item's own endpoint (the list loads
// itself when scrolled into view) or on a "Show more replies" button's command. Reading only the
// first shape is what makes a thread with dozens of replies stop after the first page
// (Scrubber's source describes exactly this), so look for the token wherever it is.
function findToken(node, depth = 0) {
	if (!node || typeof node !== "object" || depth > 12) return null;
	const token = node.continuationCommand?.token;
	if (typeof token === "string" && token) return token;
	for (const key in node) {
		const found = findToken(node[key], depth + 1);
		if (found) return found;
	}
	return null;
}

// The sort menu (Top / Newest) sits in the first page of comments; each option that is not the
// selected one carries a continuation token for the list in that order. The titles are translated,
// so options are told apart by position: Top is listed first and is selected by default, "Newest
// first" is last. Shape taken from Scrubber's source, not verified against live YouTube data.
function findNewestSort(response) {
	const menu = findByKey(response, "sortFilterSubMenuRenderer");
	const options = menu?.subMenuItems;
	if (!Array.isArray(options) || options.length < 2)
		return { token: null, current: false };
	if (options[options.length - 1].selected)
		return { token: null, current: true };
	for (let i = options.length - 1; i >= 0; i--) {
		if (options[i].selected) continue;
		const token = findToken(options[i]);
		if (token) return { token, current: false };
	}
	return { token: null, current: false };
}

function findByKey(node, key, depth = 0) {
	if (!node || typeof node !== "object" || depth > 14) return null;
	if (node[key]) return node[key];
	for (const k in node) {
		const found = findByKey(node[k], key, depth + 1);
		if (found) return found;
	}
	return null;
}

function mutationMapOf(response) {
	const mutations =
		response?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
	const map = new Map();
	for (const m of mutations) {
		if (m && m.entityKey) map.set(m.entityKey, m);
	}
	return map;
}

// The first page carries several endpoints (a header with the sort menu, then the comments), later
// pages carry one. Everything that is not a comment thread or a continuation is ignored by callers,
// so simply read all of them.
function continuationItemsOf(response) {
	const items = [];
	for (const endpoint of response?.onResponseReceivedEndpoints || []) {
		const list =
			endpoint.appendContinuationItemsAction?.continuationItems ||
			endpoint.reloadContinuationItemsCommand?.continuationItems;
		if (Array.isArray(list)) items.push(...list);
	}
	return items;
}

function commentFromThread(item, mutationMap) {
	const commentThreadRenderer = item.commentThreadRenderer;
	if (commentThreadRenderer.comment) {
		const cr = commentThreadRenderer.comment.commentRenderer;
		return {
			commentId: cr.commentId,
			authorName: cr.authorText?.simpleText,
			authorAvatar: cr.authorThumbnail?.thumbnails?.[0]?.url,
			text: cr.contentText?.runs ? legacyRunsToText(cr.contentText.runs) : "",
			styles: styleRunsFromLegacyRuns(cr.contentText?.runs),
			emojis: emojiRunsFromLegacyRuns(cr.contentText?.runs),
			...infoFromRenderer(cr),
		};
	}
	if (commentThreadRenderer.commentViewModel) {
		const commentViewModel =
			commentThreadRenderer.commentViewModel.commentViewModel ||
			commentThreadRenderer.commentViewModel;
		const mutation = mutationMap.get(commentViewModel?.commentKey);
		const payload = mutation?.payload?.commentEntityPayload;
		if (!payload) return null;
		return {
			commentId: payload.properties?.commentId,
			authorName: payload.author?.displayName,
			authorAvatar: payload.author?.avatarThumbnailUrl,
			text: payload.properties?.content?.content,
			styles: styleRunsFromContent(payload.properties?.content),
			emojis: emojiRunsFromContent(payload.properties?.content),
			...infoFromEntity(payload),
		};
	}
	return null;
}

// Extra per-comment details that can be shown next to the text. All optional; empty string / false
// when YouTube doesn't send them (e.g. no likes yet).
//   channelId  - used to look up the author's display name (displayName in the payload is the @handle)
//   likes      - already abbreviated by YouTube, e.g. "188K"
//   replies    - e.g. "961"
//   published  - e.g. "10 months ago"
function cleanCount(value) {
	if (value === undefined || value === null) return "";
	const text = String(value).trim();
	return text === "0" ? "" : text;
}

// Current format: commentEntityPayload = { author: { channelId, isVerified, isCreator },
//   toolbar: { likeCountNotliked, replyCount }, properties: { publishedTime } }
function infoFromEntity(payload) {
	const author = payload?.author;
	const toolbar = payload?.toolbar;
	return {
		channelId: author?.channelId || "",
		likes: cleanCount(toolbar?.likeCountNotliked ?? toolbar?.likeCountLiked),
		replies: cleanCount(toolbar?.replyCount),
		published: payload?.properties?.publishedTime || "",
		verified: !!author?.isVerified,
		creator: !!author?.isCreator,
		// "Official Artist Channel" (the music note badge). YouTube shows it instead of the check.
		artist: !!author?.isArtist,
		// Channel membership badge: a small image (differs per channel, tier and tenure) + its label,
		// e.g. "Member (1 year, 3 months)" or "New member". Both keys are absent for non-members.
		memberBadgeUrl: httpsUrl(author?.sponsorBadgeUrl),
		memberBadgeLabel: author?.sponsorBadgeA11y || "",
	};
}

// Only https image URLs are ever passed on to the page
export function httpsUrl(url) {
	if (typeof url !== "string") return "";
	if (url.startsWith("//")) url = "https:" + url;
	return url.startsWith("https://") ? url : "";
}

// Legacy format (best effort, not verified against live data): commentRenderer
function infoFromRenderer(cr) {
	const badge = cr?.authorCommentBadge?.authorCommentBadgeRenderer;
	const isArtist = badge?.icon?.iconType === "OFFICIAL_ARTIST_BADGE";
	const member = cr?.sponsorCommentBadge?.sponsorCommentBadgeRenderer;
	return {
		channelId: cr?.authorEndpoint?.browseEndpoint?.browseId || "",
		likes: cleanCount(cr?.voteCount?.simpleText ?? cr?.likeCount),
		replies: "",
		published:
			cr?.publishedTimeText?.runs?.[0]?.text ||
			cr?.publishedTimeText?.simpleText ||
			"",
		verified: !!cr?.authorCommentBadge && !isArtist,
		creator: !!cr?.authorIsChannelOwner,
		artist: isArtist,
		memberBadgeUrl: httpsUrl(member?.customBadge?.thumbnails?.[0]?.url),
		memberBadgeLabel: member?.tooltip || "",
	};
}

// Formatting is normalised to [{ start, end, bold, italic, strikethrough }] where start/end
// are offsets into the comment text (UTF-16 code units, same as the format YouTube sends).

// New format: content = { content, styleRuns: [{ startIndex, length, italic, strikethrough, weightLabel }] }
// Comments mark bold as FONT_WEIGHT_MEDIUM; FONT_WEIGHT_BOLD is accepted too.
function styleRunsFromContent(content) {
	const runs = content?.styleRuns;
	if (!Array.isArray(runs)) return [];
	const textLength = (content.content || "").length;
	const styles = [];
	for (const run of runs) {
		const bold =
			run.weightLabel === "FONT_WEIGHT_MEDIUM" ||
			run.weightLabel === "FONT_WEIGHT_BOLD";
		const italic = !!run.italic;
		const strikethrough = run.strikethrough === "LINE_STYLE_SINGLE";
		if (!bold && !italic && !strikethrough) continue;
		const start = run.startIndex ?? 0;
		const end = Math.min(start + (run.length ?? textLength), textLength);
		if (end > start) styles.push({ start, end, bold, italic, strikethrough });
	}
	return styles;
}

// Legacy format: contentText.runs = [{ text, bold, italics, strikethrough }]
function styleRunsFromLegacyRuns(runs) {
	if (!Array.isArray(runs)) return [];
	const styles = [];
	let offset = 0;
	for (const run of runs) {
		const length = legacyRunText(run).length;
		if (length > 0 && (run.bold || run.italics || run.strikethrough)) {
			styles.push({
				start: offset,
				end: offset + length,
				bold: !!run.bold,
				italic: !!run.italics,
				strikethrough: !!run.strikethrough,
			});
		}
		offset += length;
	}
	return styles;
}

// Legacy runs: { text } for text, { emoji: { emojiId, shortcuts, image: { thumbnails }, isCustomEmoji } } for emoji.
// Emoji runs have no `text`, so give them one (":_name:" for custom emoji, the character for Unicode emoji).
function legacyRunText(run) {
	if (typeof run.text === "string") return run.text;
	if (run.emoji) {
		return run.emoji.isCustomEmoji
			? (run.emoji.shortcuts?.[0] ?? ":emoji:")
			: (run.emoji.emojiId ?? "");
	}
	return "";
}

function legacyRunsToText(runs) {
	return Array.isArray(runs) ? runs.map(legacyRunText).join("") : "";
}

// Picks an https image URL, preferring the smallest source that is at least minWidth wide
// (emoji are shown at about text height, so the biggest source would be wasteful).
function pickImageUrl(sources, minWidth = 48) {
	if (!Array.isArray(sources)) return null;
	const candidates = sources
		.filter((src) => src && typeof src.url === "string" && src.url)
		.map((src) => ({
			width: src.width || 0,
			url: src.url.startsWith("//") ? "https:" + src.url : src.url,
		}))
		.filter((src) => src.url.startsWith("https://"))
		.sort((a, b) => a.width - b.width);
	if (candidates.length === 0) return null;
	return (
		candidates.find((src) => src.width >= minWidth) ||
		candidates[candidates.length - 1]
	).url;
}

// Emoji are normalised to [{ start, end, url, custom }] using the same offsets as the style runs.

// New format: attachmentRuns = [{ startIndex, length, element: { type: { imageType: { image: { sources } } } } }].
// Custom emoji cover their ":name:" placeholder in the text; Unicode emoji cover the emoji character.
// Runs with length 0 are other attachments (badges etc.) and are ignored.
function emojiRunsFromContent(content) {
	const runs = content?.attachmentRuns;
	if (!Array.isArray(runs)) return [];
	const text = content.content || "";
	const emojis = [];
	for (const run of runs) {
		const length = run.length ?? 0;
		if (!(length > 0)) continue;
		const start = run.startIndex ?? 0;
		const end = start + length;
		if (end > text.length) continue;

		const covered = text.slice(start, end);
		const custom = /^:[^:]+:$/.test(covered);
		if (!custom && !/^(?:\p{Emoji}|\u200d)+$/u.test(covered)) continue;

		const url = pickImageUrl(run.element?.type?.imageType?.image?.sources);
		if (url) emojis.push({ start, end, url, custom });
	}
	return emojis;
}

// Legacy format: contentText.runs entries that have an `emoji` object.
function emojiRunsFromLegacyRuns(runs) {
	if (!Array.isArray(runs)) return [];
	const emojis = [];
	let offset = 0;
	for (const run of runs) {
		const length = legacyRunText(run).length;
		if (run.emoji && length > 0) {
			const url = pickImageUrl(run.emoji.image?.thumbnails);
			if (url)
				emojis.push({
					start: offset,
					end: offset + length,
					url,
					custom: !!run.emoji.isCustomEmoji,
				});
		}
		offset += length;
	}
	return emojis;
}

function commentsContinuationToken(videoResponse) {
	const response = Array.isArray(videoResponse)
		? videoResponse.find((e) => e.response).response
		: videoResponse.response;
	return response.contents.twoColumnWatchNextResults.results.results.contents.find(
		(e) =>
			e.itemSectionRenderer &&
			e.itemSectionRenderer.sectionIdentifier === "comment-item-section",
	).itemSectionRenderer.contents[0].continuationItemRenderer
		?.continuationEndpoint.continuationCommand.token;
}

async function fetchVideo(videoId, signal) {
	return await fetchJson(
		`https://www.youtube.com/watch?v=${videoId}&pbj=1`,
		{
			credentials: "omit",
			headers: {
				"X-Youtube-Client-Name": "1",
				"X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION,
			},
		},
		signal,
	);
}

async function fetchNext(continuation, signal) {
	const body = {
		context: {
			client: {
				clientName: INNERTUBE_CLIENT_NAME,
				clientVersion: INNERTUBE_CLIENT_VERSION,
			},
		},
		continuation,
	};
	return await fetchJson(
		`https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}`,
		{
			method: "POST",
			credentials: "omit",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		signal,
	);
}

// A long scan makes thousands of requests; one hiccup (429, 5xx, dropped connection) must not
// throw away everything read so far, so transient failures are retried with a growing pause.
// Exported so tests can shrink the waits. timeoutMs: a request that hangs must not stall a scan
// that is meant to run for minutes (CommenTime gives every request 15 s as well).
export const net = { attempts: 3, baseMs: 600, timeoutMs: 20000 };

async function fetchJson(url, init, signal) {
	let lastError;
	for (let attempt = 0; attempt < net.attempts; attempt++) {
		if (signal?.aborted) throw new Error("aborted");
		const timeout = AbortSignal.timeout(net.timeoutMs);
		try {
			const response = await fetch(url, {
				...init,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (response.ok) return await response.json();
			lastError = new Error(`HTTP ${response.status}`);
			if (response.status !== 429 && response.status < 500) break;
		} catch (e) {
			if (signal?.aborted) throw e;
			lastError = timeout.aborted ? new Error("request timed out") : e;
		}
		if (attempt < net.attempts - 1) await sleep(net.baseMs * 2 ** attempt);
	}
	throw lastError;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractReplyToken(item) {
	const ctr = item.commentThreadRenderer;
	if (!ctr) return null;

	const repliesContinuation =
		ctr.replies?.commentRepliesRenderer?.contents?.[0]?.continuationItemRenderer
			?.continuationEndpoint?.continuationCommand?.token;
	if (repliesContinuation) return repliesContinuation;
	const walked = findToken(ctr.replies?.commentRepliesRenderer?.contents);
	if (walked) return walked;

	const replyCount =
		ctr.commentViewModel?.commentViewModel?.replyCount ||
		ctr.commentViewModel?.replyCount;
	if (!replyCount || replyCount === 0) return null;

	const repliesToken =
		ctr.replies?.commentRepliesRenderer?.continuations?.[0]
			?.nextContinuationData?.continuation;
	return repliesToken || null;
}

async function fetchReplies(token, signal) {
	const replies = [];
	let currentToken = token;
	let prevToken;

	while (prevToken !== currentToken) {
		const response = await fetchNext(currentToken, signal);
		prevToken = currentToken;

		const mutations =
			response.frameworkUpdates?.entityBatchUpdate?.mutations || [];
		const mutationMap = new Map();
		for (const m of mutations) {
			if (m && m.entityKey) mutationMap.set(m.entityKey, m);
		}

		const endpoints = response.onResponseReceivedEndpoints || [];
		const items =
			endpoints[0]?.appendContinuationItemsAction?.continuationItems ||
			endpoints[0]?.reloadContinuationItemsCommand?.continuationItems;

		if (!items) break;

		for (const item of items) {
			if (item.commentRenderer) {
				const cr = item.commentRenderer;
				replies.push({
					commentId: cr.commentId,
					authorName: cr.authorText?.simpleText,
					authorAvatar: cr.authorThumbnail?.thumbnails?.[0]?.url,
					text: cr.contentText?.runs
						? legacyRunsToText(cr.contentText.runs)
						: "",
					styles: styleRunsFromLegacyRuns(cr.contentText?.runs),
					emojis: emojiRunsFromLegacyRuns(cr.contentText?.runs),
					...infoFromRenderer(cr),
				});
			} else if (item.commentViewModel) {
				const commentViewModel =
					item.commentViewModel.commentViewModel || item.commentViewModel;
				const commentKey = commentViewModel?.commentKey;
				const mutation = mutationMap.get(commentKey);
				if (!mutation) continue;
				const payload = mutation.payload?.commentEntityPayload;
				if (!payload) continue;
				replies.push({
					commentId: payload.properties?.commentId,
					authorName: payload.author?.displayName,
					authorAvatar: payload.author?.avatarThumbnailUrl,
					text: payload.properties?.content?.content,
					styles: styleRunsFromContent(payload.properties?.content),
					emojis: emojiRunsFromContent(payload.properties?.content),
					...infoFromEntity(payload),
				});
			} else if (item.continuationItemRenderer) {
				const next = findToken(item.continuationItemRenderer);
				if (next) currentToken = next;
			}
		}
	}

	return replies;
}