import * as youtubei from './youtubei.js'

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'fetchTimeComments') {
        fetchTimeComments(request.videoId)
            .then(sendResponse)
            .catch(e => {
                console.error(e)
                // Always answer, otherwise the content script waits forever and looks dead
                sendResponse(null)
            })
        return true
    }
})

const DISPLAY_NAME_CONCURRENCY = 6
const DISPLAY_NAME_DEADLINE_MS = 4000     // never hold the comments back longer than this for names
const DISPLAY_NAME_TIMEOUT_MS = 8000      // per request
const DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000
const DISPLAY_NAME_FAILURE_TTL_MS = 5 * 60 * 1000
const displayNameCache = new Map()        // channelId -> { name | null, at }

async function fetchTimeComments(videoId) {
    const comments = await fetchComments(videoId)
    const timeComments = []
    for (const comment of comments) {
        const tsContexts = getTimestampContexts(comment.text)
        for (const tsContext of tsContexts) {
            timeComments.push({
                commentId: comment.commentId,
                authorAvatar: comment.authorAvatar,
                authorName: comment.authorName,
                timestamp: tsContext.timestamp,
                time: tsContext.time,
                text: tsContext.text,
                styles: comment.styles || [],
                emojis: comment.emojis || [],
                channelId: comment.channelId || '',
                likes: comment.likes || '',
                replies: comment.replies || '',
                published: comment.published || '',
                verified: !!comment.verified,
                creator: !!comment.creator,
                artist: !!comment.artist,
                memberBadgeUrl: comment.memberBadgeUrl || '',
                memberBadgeLabel: comment.memberBadgeLabel || ''
            })
        }
    }

    const settings = await browser.storage.sync.get(['authorNameMode', 'hideStampsMinTimestamps', 'hideOverlaysMinTimestamps'])

    // Comments with too many timestamps (chapter lists, "best moments" lists...) are dropped here,
    // before anything else is done with them.
    const kept = excludeByTimestampCount(
        timeComments,
        validTimestampLimit(settings.hideStampsMinTimestamps),
        validTimestampLimit(settings.hideOverlaysMinTimestamps)
    )

    // Display names cost one request per author, so only look them up when the user asked for
    // them, and only for authors of comments that are still in.
    if (settings.authorNameMode === 'display' || settings.authorNameMode === 'both') {
        await addDisplayNames(kept)
    }
    return kept
}

function validTimestampLimit(value) {
    return Number.isInteger(value) && value >= 2 ? value : null
}

// A comment is only known to have N timestamps once its text has been read, so it has to be fetched
// first. Everything after that is what this saves: no display-name lookups for its author, nothing
// sent to the page, nothing cached there, nothing for the page to build.
//
// There are two limits (progress bar, overlays). A comment is dropped only when NEITHER surface
// wants it. A surface without a limit wants every comment; the page applies each limit separately.
function excludeByTimestampCount(timeComments, barLimit, overlayLimit) {
    if (barLimit === null || overlayLimit === null) return timeComments

    const counts = new Map()
    for (const tc of timeComments) counts.set(tc.commentId, (counts.get(tc.commentId) || 0) + 1)
    return timeComments.filter(tc => {
        const count = counts.get(tc.commentId)
        return count < barLimit || count < overlayLimit
    })
}

async function addDisplayNames(timeComments) {
    const channelIds = [...new Set(timeComments.map(tc => tc.channelId).filter(Boolean))]
    if (channelIds.length === 0) return

    // Lookups that miss the deadline keep running and fill the cache for next time
    const lookups = mapLimit(channelIds, DISPLAY_NAME_CONCURRENCY, getChannelDisplayName)
    await Promise.race([lookups, new Promise(resolve => setTimeout(resolve, DISPLAY_NAME_DEADLINE_MS))])

    for (const tc of timeComments) {
        const name = cachedDisplayName(tc.channelId)
        if (name) tc.displayName = name
    }
}

function cachedDisplayName(channelId) {
    const entry = displayNameCache.get(channelId)
    if (!entry) return undefined
    const ttl = entry.name ? DISPLAY_NAME_TTL_MS : DISPLAY_NAME_FAILURE_TTL_MS
    return Date.now() - entry.at < ttl ? entry.name : undefined
}

// YouTube's comment data only has the @handle. The channel's RSS feed starts with the channel
// title, which is the display name.
async function getChannelDisplayName(channelId) {
    const entry = displayNameCache.get(channelId)
    if (entry && cachedDisplayName(channelId) !== undefined) return entry.name
    if (entry && !entry.name && Date.now() - entry.at < DISPLAY_NAME_FAILURE_TTL_MS) return null

    let name = null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISPLAY_NAME_TIMEOUT_MS)
    try {
        const response = await fetch(
            `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
            { credentials: 'omit', signal: controller.signal }
        )
        if (response.ok) name = parseFeedTitle(await response.text())
    } catch (e) {
        // leave name null: the handle is shown instead
    } finally {
        clearTimeout(timer)
    }
    displayNameCache.set(channelId, { name, at: Date.now() })
    return name
}

function parseFeedTitle(xml) {
    const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(xml)
    if (!match) return null
    let title = match[1].trim()
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(title)
    if (cdata) title = cdata[1]
    title = decodeXmlEntities(title).trim()
    return title || null
}

function decodeXmlEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
            try { return String.fromCodePoint(code) } catch (e) { return whole }
        }
        return named[body.toLowerCase()] ?? whole
    })
}

// Runs fn over items with at most `limit` in flight; never rejects
async function mapLimit(items, limit, fn) {
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++]
            try { await fn(item) } catch (e) { /* ignore */ }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function fetchComments(videoId) {
    return await youtubei.fetchComments(videoId)
}

function getTimestampContexts(text) {
    const result = []
    const positions = findTimestamps(text)
    for (const position of positions) {
        const timestamp = text.substring(position.from, position.to)
        const time = parseTimestamp(timestamp)
        if (time === null) {
            continue
        }
        result.push({
            text,
            time,
            timestamp
        })
    }
    return result
}

function findTimestamps(text) {
    const result = []
    const timestampPattern = /(\d?\d:)?(\d?\d:)\d\d/g
    let match
    while ((match = timestampPattern.exec(text))) {
        result.push({
            from: match.index,
            to: timestampPattern.lastIndex
        })
    }
    return result
}

function parseTimestamp(ts) {
    const parts = ts.split(':').reverse()
    const secs = parseInt(parts[0])
    if (secs > 59) {
        return null
    }
    const mins = parseInt(parts[1])
    if (mins > 59) {
        return null
    }
    const hours = parseInt(parts[2]) || 0
    return secs + (60 * mins) + (60 * 60 * hours)
}