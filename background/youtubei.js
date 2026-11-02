const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT_NAME = "WEB";
const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00";

export async function fetchComments(videoId) {
	const videoResponse = await fetchVideo(videoId);
	let token = commentsContinuationToken(videoResponse);
	if (!token) {
		return [];
	}
	const { maxResults, excludeReplies } = await browser.storage.sync.get([
		"maxResults",
		"excludeReplies",
	]);
	const comments = [];
	const allThreadItems = [];
	let prevToken;
	let pageCount = 0;
	while (
		prevToken !== token &&
		pageCount < maxResults &&
		comments.length < maxResults
	) {
		const commentsResponse = await fetchNext(token);
		prevToken = token;

		const mutations =
			commentsResponse.frameworkUpdates?.entityBatchUpdate?.mutations || [];
		const mutationMap = new Map();
		for (const m of mutations) {
			if (m && m.entityKey) {
				mutationMap.set(m.entityKey, m);
			}
		}

		const items =
			pageCount === 0
				? commentsResponse.onResponseReceivedEndpoints[1]
						.reloadContinuationItemsCommand.continuationItems
				: commentsResponse.onResponseReceivedEndpoints[0]
						.appendContinuationItemsAction.continuationItems;
		if (!items) {
			break;
		}

		for (const item of items) {
			if (item.commentThreadRenderer) {
				allThreadItems.push(item);
				const commentThreadRenderer = item.commentThreadRenderer;
				if (commentThreadRenderer.comment) {
					const cr = commentThreadRenderer.comment.commentRenderer;
					const commentId = cr.commentId;
					const authorName = cr.authorText?.simpleText;
					const authorAvatar = cr.authorThumbnail?.thumbnails?.[0]?.url;
					const text = cr.contentText?.runs
						? legacyRunsToText(cr.contentText.runs)
						: "";
					const styles = styleRunsFromLegacyRuns(cr.contentText?.runs);
					const emojis = emojiRunsFromLegacyRuns(cr.contentText?.runs);
					comments.push({
						commentId,
						authorName,
						authorAvatar,
						text,
						styles,
						emojis,
						...infoFromRenderer(cr),
					});
				} else if (commentThreadRenderer.commentViewModel) {
					const commentViewModel =
						commentThreadRenderer.commentViewModel.commentViewModel ||
						commentThreadRenderer.commentViewModel;
					const commentKey = commentViewModel?.commentKey;
					const mutation = mutationMap.get(commentKey);
					if (!mutation) continue;
					const commentEntityPayload = mutation.payload?.commentEntityPayload;
					if (!commentEntityPayload) continue;
					const commentId = commentEntityPayload.properties?.commentId;
					const authorName = commentEntityPayload.author?.displayName;
					const authorAvatar = commentEntityPayload.author?.avatarThumbnailUrl;
					const text = commentEntityPayload.properties?.content?.content;
					const styles = styleRunsFromContent(
						commentEntityPayload.properties?.content,
					);
					const emojis = emojiRunsFromContent(
						commentEntityPayload.properties?.content,
					);
					comments.push({
						commentId,
						authorName,
						authorAvatar,
						text,
						styles,
						emojis,
						...infoFromEntity(commentEntityPayload),
					});
				}
			} else if (item.continuationItemRenderer) {
				token =
					item.continuationItemRenderer.continuationEndpoint.continuationCommand
						.token;
			}
		}
		pageCount++;
	}

	// Replies cost one or more extra requests per thread, so when they are excluded they are
	// never fetched at all (not just filtered out afterwards)
	if (!excludeReplies) {
		for (const item of allThreadItems) {
			const replyToken = extractReplyToken(item);
			if (!replyToken) continue;
			const replyComments = await fetchReplies(replyToken);
			comments.push(...replyComments);
		}
	}

	return comments;
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
function httpsUrl(url) {
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

async function fetchVideo(videoId) {
	const response = await fetch(
		`https://www.youtube.com/watch?v=${videoId}&pbj=1`,
		{
			credentials: "omit",
			headers: {
				"X-Youtube-Client-Name": "1",
				"X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION,
			},
		},
	);
	return await response.json();
}

async function fetchNext(continuation) {
	const body = {
		context: {
			client: {
				clientName: INNERTUBE_CLIENT_NAME,
				clientVersion: INNERTUBE_CLIENT_VERSION,
			},
		},
		continuation,
	};
	const response = await fetch(
		`https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}`,
		{
			method: "POST",
			credentials: "omit",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	return await response.json();
}

function extractReplyToken(item) {
	const ctr = item.commentThreadRenderer;
	if (!ctr) return null;

	const repliesContinuation =
		ctr.replies?.commentRepliesRenderer?.contents?.[0]?.continuationItemRenderer
			?.continuationEndpoint?.continuationCommand?.token;
	if (repliesContinuation) return repliesContinuation;

	const replyCount =
		ctr.commentViewModel?.commentViewModel?.replyCount ||
		ctr.commentViewModel?.replyCount;
	if (!replyCount || replyCount === 0) return null;

	const repliesToken =
		ctr.replies?.commentRepliesRenderer?.continuations?.[0]
			?.nextContinuationData?.continuation;
	return repliesToken || null;
}

async function fetchReplies(token) {
	const replies = [];
	let currentToken = token;
	let prevToken;

	while (prevToken !== currentToken) {
		const response = await fetchNext(currentToken);
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
				const next =
					item.continuationItemRenderer?.continuationEndpoint
						?.continuationCommand?.token;
				if (next) currentToken = next;
			}
		}
	}

	return replies;
}
