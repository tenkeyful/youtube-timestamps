// CONFIGURATION // cuz this add-on is experimental, subject to future changes
const PREVIEW_DEFAULT_WIDTH     = 320
const PREVIEW_MAX_HEIGHT        = 175
const PREVIEW_MIN_HEIGHT        = 40
// Vertical margins between the header, text and button. They are part of the card's content, so the
// cap has to include them or the button at the bottom gets pushed out of the card.
const PREVIEW_MARGINS_TOTAL     = 24
const PREVIEW_AVATAR_SIZE       = 24   // matches the avatar's CSS width/height
const PREVIEW_BORDER_SIZE       = 2
const PREVIEW_TOOLTIP_MARGIN    = 12
const PREVIEW_MARGIN            = 10
const PREVIEW_WIDTH_PADDING     = 5
const WHEEL_SWITCH_THRESHOLD    = 100
const WHEEL_DEBOUNCE_MS         = 400
const SCROLL_TOLERANCE          = 1
const TIME_TOLERANCE            = 0.5
const OVERLAY_FADE_DURATION     = 500

// LIVE OVERLAY //
let timeComments = []
let activeOverlays = []
let lastVideoTime = 0
let overlayContainer = null

// LIFECYCLE //
// The add-on follows what is actually on screen instead of trusting YouTube's navigation
// events to arrive in a predictable order (they don't, e.g. around the miniplayer).
const DEBUG = false                       // true = log lifecycle decisions to the page console
const WATCHDOG_INTERVAL_MS = 500          // how often the page is re-checked
const HIT_RADIUS_PX = 8                   // how close (px) the cursor must be to a tick to hover it
const HIT_BAND_ABOVE_PX = 24              // YouTube's own hover zone reaches well above the thin bar
const HIT_BAND_BELOW_PX = 8
const COMMENT_CACHE_TTL_MS = 10 * 60 * 1000
const COMMENT_CACHE_MAX = 5
const RETRY_DELAY_MS = 8000

let activeVideoId = null                  // video the add-on is currently showing comments for
let commentsReady = false                 // comments for activeVideoId are loaded
let stampComments = []                    // what the progress bar shows
let loadToken = 0                         // bumped on every (de)activation; cancels stale async work
let retryVideoId = null
let retryAt = 0
let pendingMeta = null                    // { video, handler } waiting for loadedmetadata
let hoveredStamp = null                   // stamp the preview is currently anchored to
let previewRaf = 0                        // requestAnimationFrame id of the preview layout loop
let stampEntries = []                     // ticks on screen: { el, fraction, commentsAtTime, index }
let hoveredEntry = null                   // tick the cursor is currently over
const hookedPlayers = new WeakSet()       // players that already have our mouse listeners
let playerObserver = null                 // watches the player for our tick layer being removed
let observedPlayer = null
let reattachQueued = false
let builtDuration = 0                     // video duration the current ticks were positioned with
let awayFromWatch = false                 // true while off the watch page (e.g. playing in the miniplayer)
let lastHoverLog = 0
const openCommentInNewTab = createDebouncedCommentOpener()
const commentCache = new Map()            // videoId -> { comments, at }

function log(...args) {
    if (DEBUG) console.log('[youtube-timestamps]', ...args)
}

// OPTIONS MENU //
let OVERLAY_DURATION = 4000
let MAX_CONCURRENT_OVERLAYS = 3
let OVERLAY_OPACITY = 1
// Comments with this many timestamps or more are hidden (null = off)
let HIDE_STAMPS_MIN_TIMESTAMPS = null
let HIDE_OVERLAYS_MIN_TIMESTAMPS = null
// Overlay placement and size
const OVERLAY_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']
let OVERLAY_POSITION = 'top-left'
let OVERLAY_SCALE = 1
let OVERLAY_SLIDE_HORIZONTAL = false     // false: slide up/down; true: slide left/right
let OVERLAY_WIDTH_FIT = false             // false: every overlay as wide as the widest; true: each fits its own text
// When overlays come and go the others glide to their new place instead of jumping
const OVERLAY_REFLOW_MS = 320
const OVERLAY_REFLOW_EASING = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'
// What is shown with each comment (all default to the original look: just the @handle)
let AUTHOR_NAME_MODE = 'handle'           // 'handle' | 'display' | 'both'
let SHOW_LIKES = false
let SHOW_REPLIES = false
let SHOW_PUBLISHED = false
let SHOW_BADGES = false
let FULLSCREEN_SCALE = null               // explicit full screen size; null = scale automatically
// Automatic full screen scaling: overlays grow with the player so they keep about the same
// share of the screen, instead of shrinking to a corner when the video gets big.
const FULLSCREEN_AUTO_REFERENCE_HEIGHT = 540   // player height (px) at which the normal size is "100%"
const FULLSCREEN_AUTO_MAX = 3
const OVERLAY_BOTTOM_OFFSET_MIN = 70           // px kept clear above the controls for bottom positions

const optionsReady = browser.storage.sync.get(['maxConcurrentOverlays','overlayDuration','overlayOpacity','hideStampsMinTimestamps','hideOverlaysMinTimestamps','overlayPosition','overlaySize','fullscreenOverlaySize','authorNameMode','showLikes','showReplies','showPublished','showBadges','overlayWidthMode','overlayAnimationAxis'])
.then((items) => {
    if (OVERLAY_POSITIONS.includes(items.overlayPosition)) {
        OVERLAY_POSITION = items.overlayPosition
    }
    if (Number.isFinite(items.overlaySize) && items.overlaySize >= 50 && items.overlaySize <= 200) {
        OVERLAY_SCALE = items.overlaySize / 100
    }
    if (items.authorNameMode === 'display' || items.authorNameMode === 'both') {
        AUTHOR_NAME_MODE = items.authorNameMode
    }
    OVERLAY_WIDTH_FIT = items.overlayWidthMode === 'fit'
    OVERLAY_SLIDE_HORIZONTAL = items.overlayAnimationAxis === 'horizontal'
    SHOW_LIKES = items.showLikes === true
    SHOW_REPLIES = items.showReplies === true
    SHOW_PUBLISHED = items.showPublished === true
    SHOW_BADGES = items.showBadges === true
    if (Number.isFinite(items.fullscreenOverlaySize) && items.fullscreenOverlaySize >= 50 && items.fullscreenOverlaySize <= 400) {
        FULLSCREEN_SCALE = items.fullscreenOverlaySize / 100
    }
    if (Number.isInteger(items.hideStampsMinTimestamps) && items.hideStampsMinTimestamps >= 2) {
        HIDE_STAMPS_MIN_TIMESTAMPS = items.hideStampsMinTimestamps
    }
    if (Number.isInteger(items.hideOverlaysMinTimestamps) && items.hideOverlaysMinTimestamps >= 2) {
        HIDE_OVERLAYS_MIN_TIMESTAMPS = items.hideOverlaysMinTimestamps
    }
    if (items.hasOwnProperty('maxConcurrentOverlays') && typeof items.maxConcurrentOverlays === 'number') {
        MAX_CONCURRENT_OVERLAYS = items.maxConcurrentOverlays
    }
    if (items.hasOwnProperty('overlayDuration') && typeof items.overlayDuration === 'number') {
        OVERLAY_DURATION = items.overlayDuration
    }
    if (items.hasOwnProperty('overlayOpacity') && typeof items.overlayOpacity === 'number') {
        OVERLAY_OPACITY = items.overlayOpacity
    }

    const existing = document.querySelectorAll('.__youtube-timestamps__live-overlay')
    existing.forEach(el => {
        el.style.setProperty('--yt-user-opacity', String(OVERLAY_OPACITY))
    })
})
.catch((err) => {
})

// Decides what the add-on should be doing right now and fixes any difference. Safe to call
// at any time, any number of times: on navigation events, on a timer, on script load.
async function sync() {
    const watchId = getVideoId()

    if (!watchId) {
        // Not on a watch page (home, subscriptions, ...). The player may be sitting in the
        // miniplayer and come back, so keep everything that is loaded and attached; just make
        // sure nothing pops up or stays on screen meanwhile.
        if (overlayContainer || hoveredEntry) {
            log('left watch page, pausing overlays and preview')
            removeOverlayContainer()
            hidePreview()
        }
        if (!awayFromWatch) log('not on a watch page (miniplayer?), hiding ticks')
        awayFromWatch = true
        setBarHidden(true)   // no ticks in the miniplayer; they stay attached and come back with the player
        return
    }

    setBarHidden(false)

    if (awayFromWatch) {
        awayFromWatch = false
        if (watchId === activeVideoId && commentsReady) {
            // Don't trust anything left over from before: geometry, hooks and the video itself
            // may all have changed while the player was parked elsewhere.
            log('back on the watch page, rebuilding the tick layer from scratch')
            rebuildBar()
            return
        }
    }

    if (watchId !== activeVideoId) {
        if (retryVideoId === watchId && Date.now() < retryAt) return
        await activate(watchId)
        return
    }

    ensureAttached()
}

async function activate(videoId) {
    deactivate()
    const token = loadToken
    activeVideoId = videoId
    log('activating', videoId)

    const [comments] = await Promise.all([
        loadComments(videoId),
        waitForSelector('#movie_player video', 2000).catch(() => null),
        optionsReady
    ])

    if (token !== loadToken) return   // superseded while loading

    if (comments === null) {
        log('loading comments failed, will retry')
        activeVideoId = null
        retryVideoId = videoId
        retryAt = Date.now() + RETRY_DELAY_MS
        return
    }

    if (getVideoId() !== videoId) return   // URL moved on; the next sync() sorts it out

    timeComments = filterByTimestampCount(comments, HIDE_OVERLAYS_MIN_TIMESTAMPS)
    stampComments = filterByTimestampCount(comments, HIDE_STAMPS_MIN_TIMESTAMPS)
    commentsReady = true
    log('ready', videoId, comments.length, 'timestamps;', stampComments.length, 'left for the bar and',
        timeComments.length, 'for overlays after the "N+ timestamps" filters (bar filter:',
        HIDE_STAMPS_MIN_TIMESTAMPS ?? 'off', ', overlay filter:', HIDE_OVERLAYS_MIN_TIMESTAMPS ?? 'off', ')')
    addTimeComments(stampComments, token)
}

function deactivate() {
    loadToken++
    activeVideoId = null
    commentsReady = false
    builtDuration = 0
    timeComments = []
    stampComments = []
    removeBar()
    removeOverlayContainer()
    hidePreview()
}

// Makes sure the UI is attached to the current player and sized correctly. Cheap when everything
// is fine, so it runs on a timer, on resize/fullscreen, and whenever our layer gets removed.
function ensureAttached() {
    if (!commentsReady || !getVideoId()) return
    const player = getPlayer()
    if (!player) return

    hookPlayer(player)
    observePlayer(player)

    if (overlayContainer && !player.contains(overlayContainer)) {
        log('overlay container no longer in the player, dropping it')
        removeOverlayContainer()
    }
    applyOverlayScale()

    const video = getVideo()
    const duration = video?.duration
    if (!(Number.isFinite(duration) && duration > 0)) return

    // YouTube reuses one <video> for every video, so it can still report the previous video's
    // length when ticks get built. Ticks positioned with the wrong length are in the wrong place.
    if (builtDuration && Math.abs(duration - builtDuration) > 0.5) {
        log('video duration changed', Math.round(builtDuration), '->', Math.round(duration), ', rebuilding ticks')
        rebuildBar()
        return
    }

    const bars = document.querySelectorAll('.__youtube-timestamps__bar')
    if (bars.length !== 1 || bars[0].parentElement !== getBarMountPoint(player)) {
        log('tick layer missing or misplaced, rebuilding')
        removeBar()
        addTimeComments(stampComments)
        return
    }
    layoutBar(bars[0])
}

function setBarHidden(hidden) {
    const display = hidden ? 'none' : ''
    document.querySelectorAll('.__youtube-timestamps__bar').forEach(bar => {
        if (bar.style.display !== display) bar.style.display = display
    })
}

function rebuildBar() {
    removeBar()
    addTimeComments(stampComments)
    // the player may still be settling into its new size: re-check shortly after
    for (const delay of [150, 400, 900]) setTimeout(scheduleReattach, delay)
}

function scheduleReattach() {
    if (reattachQueued) return
    reattachQueued = true
    requestAnimationFrame(() => {
        reattachQueued = false
        ensureAttached()
    })
}

// YouTube tears down and rebuilds parts of the player. If that takes our layer with it, put it
// back right away instead of waiting for the next timer tick.
function observePlayer(player) {
    if (observedPlayer === player && playerObserver) return
    playerObserver?.disconnect()
    observedPlayer = player
    playerObserver = new MutationObserver(() => {
        if (commentsReady && !document.querySelector('.__youtube-timestamps__bar')) scheduleReattach()
    })
    playerObserver.observe(player, { childList: true, subtree: true })
}

async function loadComments(videoId) {
    const cached = commentCache.get(videoId)
    if (cached && Date.now() - cached.at < COMMENT_CACHE_TTL_MS) {
        log('comments from cache', videoId)
        return cached.comments
    }

    const comments = await fetchTimeComments(videoId)
    if (!Array.isArray(comments)) return null

    commentCache.set(videoId, { comments, at: Date.now() })
    while (commentCache.size > COMMENT_CACHE_MAX) {
        commentCache.delete(commentCache.keys().next().value)
    }
    return comments
}

// Drops every timestamp of comments that contain `minTimestamps` or more timestamps.
// Catches chapter lists, "best moments" lists, etc. The background script emits one
// entry per timestamp occurrence, so entries per commentId = timestamps in that comment.
function filterByTimestampCount(comments, minTimestamps) {
    if (!Array.isArray(comments)) return []
    if (minTimestamps == null) return comments

    const counts = new Map()
    for (const tc of comments) {
        counts.set(tc.commentId, (counts.get(tc.commentId) || 0) + 1)
    }
    return comments.filter(tc => counts.get(tc.commentId) < minTimestamps)
}

function getVideoId() {
    if (window.location.pathname === '/watch') {
        return parseParams(window.location.href)['v']
    }
    return null
}

// The watch-page player. YouTube moves one player between the watch page and the miniplayer,
// so prefer the one inside the watch page and fall back to any #movie_player.
function getPlayer() {
    return document.querySelector('ytd-watch-flexy #movie_player, ytd-watch-grid #movie_player')
        || document.querySelector('#movie_player')
}

function getVideo() {
    return getPlayer()?.querySelector('video') || null
}

// Resolves to the comments array, or null if the background failed or never answered
function fetchTimeComments(videoId) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 60000)
        try {
            browser.runtime.sendMessage({type: 'fetchTimeComments', videoId}, (response) => {
                clearTimeout(timer)
                resolve(Array.isArray(response) ? response : null)
            })
        } catch (err) {
            clearTimeout(timer)
            resolve(null)
        }
    })
}

function handleTimeUpdate(event) {
    if (!getVideoId()) return   // e.g. playing in the miniplayer: no popups
    const video = event.target
    const currentTime = video.currentTime

    if (video.paused || Math.abs(currentTime - lastVideoTime) < 0.1) {
        lastVideoTime = currentTime
        return
    }

    const commentsToShow = timeComments.filter(tc => {
        const timeDiff = Math.abs(tc.time - currentTime)
        return timeDiff <= TIME_TOLERANCE && !isCommentCurrentlyShown(tc)
    })

    commentsToShow.forEach(showLiveOverlay)
    lastVideoTime = currentTime
}

function isCommentCurrentlyShown(comment) {
    return activeOverlays.some(overlay =>
        overlay.commentId === comment.commentId &&
        overlay.timestamp === comment.timestamp
    )
}

function showLiveOverlay(timeComment) {
    if (activeOverlays.length >= MAX_CONCURRENT_OVERLAYS) {
        const oldestOverlay = activeOverlays.shift()
        removeOverlay(oldestOverlay)
    }

    const container = getOrCreateOverlayContainer()
    const overlay = createOverlayElement(timeComment)

    // The overlay itself is zoomed (for the size setting). Its wrapper is not, so everything that
    // measures or animates positions can work in plain pixels.
    const slot = document.createElement('div')
    slot.className = '__youtube-timestamps__overlay-slot'
    slot.appendChild(overlay)

    const overlayData = {
        element: overlay,
        slot,
        commentId: timeComment.commentId,
        timestamp: timeComment.timestamp,
        startTime: Date.now()
    }
    // For stacks anchored to the bottom a new overlay pushes the older ones up
    animateReflow(() => {
        container.appendChild(slot)
        activeOverlays.push(overlayData)
    })

    requestAnimationFrame(() => {
        overlay.style.opacity = String(OVERLAY_OPACITY)
        overlay.style.transform = 'translateX(0)'
    })

    setTimeout(() => {
        removeOverlay(overlayData)
    }, OVERLAY_DURATION)
}

function isPlayerFullscreen(player = getPlayer()) {
    return !!document.fullscreenElement || !!player?.classList.contains('ytp-fullscreen')
}

// Size of the overlays right now: the normal size, or in full screen either the explicit
// full screen size or the normal size scaled up with the player.
function currentOverlayScale() {
    const player = getPlayer()
    if (!isPlayerFullscreen(player)) return OVERLAY_SCALE
    if (FULLSCREEN_SCALE !== null) return FULLSCREEN_SCALE

    const height = player?.getBoundingClientRect().height || 0
    const auto = Math.min(Math.max(height / FULLSCREEN_AUTO_REFERENCE_HEIGHT, 1), FULLSCREEN_AUTO_MAX)
    return OVERLAY_SCALE * auto
}

// Bottom positions have to clear the controls, which are taller in full screen
function currentOverlayBottomOffset() {
    const player = getPlayer()
    const controls = player?.querySelector('.ytp-chrome-bottom')
    if (!player || !controls) return OVERLAY_BOTTOM_OFFSET_MIN
    const controlsRect = controls.getBoundingClientRect()
    if (!(controlsRect.height > 0)) return OVERLAY_BOTTOM_OFFSET_MIN
    const needed = Math.round(player.getBoundingClientRect().bottom - controlsRect.top + 12)
    return Math.min(Math.max(needed, OVERLAY_BOTTOM_OFFSET_MIN), 200)
}

function setOverlayVars(container) {
    const scale = String(Math.round(currentOverlayScale() * 1000) / 1000)
    const bottom = currentOverlayBottomOffset() + 'px'
    if (container.style.getPropertyValue('--yt-overlay-scale') !== scale) {
        container.style.setProperty('--yt-overlay-scale', scale)
    }
    if (container.style.getPropertyValue('--yt-overlay-bottom') !== bottom) {
        container.style.setProperty('--yt-overlay-bottom', bottom)
    }
}

// Re-applied on resize / fullscreen changes so overlays that are already showing resize live
function applyOverlayScale() {
    if (overlayContainer?.isConnected) setOverlayVars(overlayContainer)
}

// Overlays slide in from above when anchored to the top, from below when anchored to the bottom
// Overlays slide in from, and back out to, the screen edge their stack is anchored to.
//   up/down:    top stacks come in moving down and leave moving up; bottom stacks the other way round
//   left/right: left stacks come in moving right and leave moving left; right stacks the other way round
//               (centred stacks have no side, so they behave like left ones)
// Each value is where the overlay starts (entering) or ends up (leaving), relative to its resting place.
function overlayMotion() {
    if (OVERLAY_SLIDE_HORIZONTAL) {
        const side = OVERLAY_POSITION.endsWith('right') ? 1 : -1
        return { enter: `translateX(${side * 24}px)`, exit: `translateX(${side * 14}px)` }
    }
    const side = OVERLAY_POSITION.startsWith('bottom') ? 1 : -1
    return { enter: `translateY(${side * 20}px)`, exit: `translateY(${side * 12}px)` }
}

// Smooth re-layout (the "FLIP" technique). `change` adds or removes overlays. Every overlay that is
// still there is measured before and after; whatever moved is animated from its old position to
// its new one, so nothing jumps.
function animateReflow(change) {
    const canAnimate = typeof Element.prototype.animate === 'function'
        && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    const before = new Map()
    if (canAnimate) {
        for (const data of activeOverlays) {
            const slot = data.slot
            if (slot?.isConnected) before.set(slot, slot.getBoundingClientRect().top)
        }
    }

    change()
    if (!canAnimate) return

    for (const [slot, oldTop] of before) {
        if (!slot.isConnected || slot.dataset.leaving) continue
        const dy = oldTop - slot.getBoundingClientRect().top
        if (Math.abs(dy) < 0.5) continue
        // 'add' stacks on top of a move that is still running instead of replacing it
        slot.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: OVERLAY_REFLOW_MS, easing: OVERLAY_REFLOW_EASING, composite: 'add' }
        )
    }
}

// Takes a slot out of the layout without moving it, so the others can close the gap while it fades.
// It has to be pinned to the side the stack is anchored to: the container shrinks when the slot
// leaves, and a bottom-, right- or centre-anchored container would otherwise carry it along.
function pinInPlace(slot) {
    const container = slot.parentElement
    if (!container) return
    const rect = slot.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    const position = container.dataset.position || 'top-left'

    slot.dataset.leaving = '1'
    slot.style.position = 'absolute'
    slot.style.margin = '0'
    slot.style.width = rect.width + 'px'

    if (position.startsWith('bottom')) slot.style.bottom = (box.bottom - rect.bottom) + 'px'
    else slot.style.top = (rect.top - box.top) + 'px'

    if (position.endsWith('right')) {
        slot.style.right = (box.right - rect.right) + 'px'
    } else if (position.endsWith('center')) {
        // the container stays centred however wide it is, so measure from its centre
        slot.style.left = `calc(50% + ${rect.left - (box.left + box.width / 2)}px)`
    } else {
        slot.style.left = (rect.left - box.left) + 'px'
    }
}

function removeOverlay(overlayData) {
    if (!overlayData || !overlayData.element || overlayData.leaving) return
    overlayData.leaving = true
    const overlay = overlayData.element
    const slot = overlayData.slot || overlay

    const idx = activeOverlays.indexOf(overlayData)
    if (idx > -1) activeOverlays.splice(idx, 1)

    // the others close the gap (animated) while this one fades out where it was
    animateReflow(() => pinInPlace(slot))

    overlay.style.opacity = '0'
    overlay.style.transform = overlayMotion().exit

    setTimeout(() => {
        if (slot.parentNode) slot.parentNode.removeChild(slot)
    }, OVERLAY_FADE_DURATION)
}

const TIMESTAMP_REGEX_SOURCE = '(\\d?\\d:)?(\\d?\\d:)\\d\\d'

// YouTube emoji (custom and Unicode) are images. The placeholder text (":_name:" or the
// character) stays as alt text and as the fallback if the image fails to load.
function createEmojiNode(emoji, fallbackText) {
    if (typeof emoji.url !== 'string' || !emoji.url.startsWith('https://')) {
        return document.createTextNode(fallbackText)
    }
    const img = document.createElement('img')
    img.className = '__youtube-timestamps__emoji'
    img.alt = fallbackText
    img.draggable = false
    img.addEventListener('error', () => img.replaceWith(document.createTextNode(fallbackText)))
    img.src = emoji.url
    return img
}

// Text nodes for text.slice(from, to), split wherever the formatting changes and wrapped
// in bold / italic / strikethrough spans.
function createStyledNodes(text, styles, from, to, emojis = []) {
    const cuts = new Set([from, to])
    for (const st of styles) {
        if (st.start > from && st.start < to) cuts.add(st.start)
        if (st.end > from && st.end < to) cuts.add(st.end)
    }
    for (const em of emojis) {
        if (em.start > from && em.start < to) cuts.add(em.start)
        if (em.end > from && em.end < to) cuts.add(em.end)
    }
    const points = [...cuts].sort((a, b) => a - b)

    const nodes = []
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]
        const b = points[i + 1]
        const covering = styles.filter(st => st.start <= a && st.end >= b)
        const emoji = emojis.find(em => em.start === a && em.end === b)
        let node = emoji ? createEmojiNode(emoji, text.slice(a, b)) : document.createTextNode(text.slice(a, b))
        const wrap = (cls) => {
            const span = document.createElement('span')
            span.className = cls
            span.appendChild(node)
            node = span
        }
        if (covering.some(st => st.strikethrough)) wrap('__youtube-timestamps__fmt-strike')
        if (covering.some(st => st.italic)) wrap('__youtube-timestamps__fmt-italic')
        if (covering.some(st => st.bold)) wrap('__youtube-timestamps__fmt-bold')
        nodes.push(node)
    }
    return nodes
}

// Builds the comment text as a fragment with formatting applied. Every timestamp in the
// text is passed to createStamp(ts); if it returns an element, the (styled) timestamp
// text goes inside it, otherwise it is rendered as ordinary text.
function createStyledFragment(text, styles, createStamp, emojis) {
    const frag = document.createDocumentFragment()
    if (!text) return frag
    styles = Array.isArray(styles) ? styles : []
    emojis = Array.isArray(emojis) ? emojis : []

    const regex = new RegExp(TIMESTAMP_REGEX_SOURCE, 'g')
    let lastIndex = 0
    let match
    while ((match = regex.exec(text)) !== null) {
        const from = match.index
        const to = regex.lastIndex
        for (const node of createStyledNodes(text, styles, lastIndex, from, emojis)) frag.appendChild(node)

        const stamp = createStamp ? createStamp(text.slice(from, to)) : null
        const nodes = createStyledNodes(text, styles, from, to, emojis)
        if (stamp) {
            for (const node of nodes) stamp.appendChild(node)
            frag.appendChild(stamp)
        } else {
            for (const node of nodes) frag.appendChild(node)
        }
        lastIndex = to
    }
    for (const node of createStyledNodes(text, styles, lastIndex, text.length, emojis)) frag.appendChild(node)
    return frag
}

// Makes a timestamp written in a comment seek the video when clicked (or activated with the keyboard)
function makeTimestampSeekable(span, ts) {
    span.setAttribute('role', 'button')
    span.tabIndex = 0
    span.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const secs = parseTimestampToSeconds(ts)
        const video = getVideo && getVideo()
        if (video && secs != null) {
            video.currentTime = Math.max(0, Math.min(video.duration || Infinity, secs))
            video.play().catch(()=>{})
        }
    })
    span.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            span.click()
        }
    })
}

// The timestamp this overlay is showing gets the full highlight (accent text, background and
// border). Any other timestamp in the same comment gets the accent text colour only. Both seek.
function formatCommentTextWithTimestampSpans(text, activeTimestamp, styles, emojis) {
    return createStyledFragment(text, styles, (ts) => {
        const isActive = !!activeTimestamp && ts === activeTimestamp
        if (!isActive && parseTimestampToSeconds(ts) == null) return null   // not a real timestamp (e.g. 1:99)

        const span = document.createElement('span')
        span.className = isActive
            ? '__youtube-timestamps__live-overlay__text-stamp'
            : '__youtube-timestamps__live-overlay__text-link'
        makeTimestampSeekable(span, ts)
        return span
    }, emojis)
}

function parseTimestampToSeconds(ts) {
    if (!ts || typeof ts !== 'string') return null
    const parts = ts.split(':').map(p => parseInt(p, 10))
    if (parts.some(p => Number.isNaN(p))) return null
    if (parts.length === 1) return parts[0]
    if (parts.length === 2) {
        const [m, s] = parts
        if (s > 59) return null
        return m * 60 + s
    }
    const last3 = parts.slice(-3)
    const [h, m, s] = last3
    if (s > 59 || m > 59) return null
    return h * 3600 + m * 60 + s
}

// Fills `el` with the author's name (handle, display name or both, depending on the option),
// followed by badges if enabled. `displayName` only exists when the background looked it up.
function fillAuthorName(el, timeComment) {
    el.textContent = ''
    const handle = timeComment.authorName || ''
    const display = timeComment.displayName || ''

    let main = handle || 'Unknown'
    let secondary = ''
    if (AUTHOR_NAME_MODE !== 'handle' && display) {
        main = display
        if (AUTHOR_NAME_MODE === 'both' && handle && handle !== display) secondary = handle
    }

    el.appendChild(document.createTextNode(main))
    if (secondary) {
        const handleEl = document.createElement('span')
        handleEl.className = '__youtube-timestamps__handle'
        handleEl.textContent = ' ' + secondary
        el.appendChild(handleEl)
    }

    if (SHOW_BADGES) {
        if (timeComment.verified) {
            const badge = document.createElement('span')
            badge.className = '__youtube-timestamps__badge __youtube-timestamps__badge--verified'
            badge.title = 'Verified'
            badge.dataset.glyph = '✓'    // drawn by CSS so it can take the card's background colour
            el.appendChild(badge)
        }
        if (timeComment.artist) {
            const badge = document.createElement('span')
            badge.className = '__youtube-timestamps__badge __youtube-timestamps__badge--artist'
            badge.title = 'Official Artist Channel'
            badge.dataset.glyph = '♪'
            el.appendChild(badge)
        }
        if (timeComment.creator) {
            const badge = document.createElement('span')
            badge.className = '__youtube-timestamps__badge __youtube-timestamps__badge--creator'
            badge.title = 'Channel owner'
            badge.textContent = 'Creator'
            el.appendChild(badge)
        }
        // Membership badge: the channel's own badge image
        if (typeof timeComment.memberBadgeUrl === 'string' && timeComment.memberBadgeUrl.startsWith('https://')) {
            const img = document.createElement('img')
            img.className = '__youtube-timestamps__badge-member'
            img.alt = timeComment.memberBadgeLabel || 'Member'
            img.title = timeComment.memberBadgeLabel || 'Member'
            img.draggable = false
            img.addEventListener('error', () => img.remove())
            img.src = timeComment.memberBadgeUrl
            el.appendChild(img)
        }
    }
}

// "188K likes · 961 replies · 10 months ago", limited to what is enabled and available
function buildMetaText(timeComment) {
    const parts = []
    if (SHOW_LIKES && timeComment.likes) {
        parts.push(`${timeComment.likes} ${timeComment.likes === '1' ? 'like' : 'likes'}`)
    }
    if (SHOW_REPLIES && timeComment.replies) {
        parts.push(`${timeComment.replies} ${timeComment.replies === '1' ? 'reply' : 'replies'}`)
    }
    if (SHOW_PUBLISHED && timeComment.published) parts.push(timeComment.published)
    return parts.join(' · ')
}

function createOverlayElement(timeComment) {
    const overlay = document.createElement('div')
    overlay.className = '__youtube-timestamps__live-overlay'

    const avatar = document.createElement('img')
    avatar.className = '__youtube-timestamps__live-overlay__avatar'
    avatar.alt = timeComment.authorName || 'User'
    avatar.src = timeComment.authorAvatar || ''

    const content = document.createElement('div')
    content.className = '__youtube-timestamps__live-overlay__content'

    const authorName = document.createElement('div')
    authorName.className = '__youtube-timestamps__live-overlay__author'
    fillAuthorName(authorName, timeComment)

    const metaText = buildMetaText(timeComment)
    let meta = null
    if (metaText) {
        meta = document.createElement('div')
        meta.className = '__youtube-timestamps__live-overlay__meta'
        meta.textContent = metaText
    }

    const commentText = document.createElement('div')
    commentText.className = '__youtube-timestamps__live-overlay__text'
    commentText.appendChild(formatCommentTextWithTimestampSpans(timeComment.text || '', timeComment.timestamp, timeComment.styles, timeComment.emojis))

    const scrollShadow = document.createElement('div')
    scrollShadow.className = '__youtube-timestamps__live-overlay__text-scroll-shadow'
    scrollShadow.style.opacity = '0'

    const updateShadow = () => {
        const isScrollable = commentText.scrollHeight > commentText.clientHeight + 2
        const atBottom = commentText.scrollTop + commentText.clientHeight >= commentText.scrollHeight - 2
        scrollShadow.style.opacity = (isScrollable && !atBottom) ? '1' : '0'
    }

    commentText.addEventListener('scroll', updateShadow)
    requestAnimationFrame(() => requestAnimationFrame(updateShadow))

    content.appendChild(authorName)
    if (meta) content.appendChild(meta)
    content.appendChild(commentText)
    commentText.appendChild(scrollShadow)

    overlay.appendChild(avatar)
    overlay.appendChild(content)

    commentText.addEventListener('wheel', (e) => {
        const atTop = commentText.scrollTop <= 0
        const atBottom = (commentText.scrollTop + commentText.clientHeight) >= (commentText.scrollHeight - 1)
        if (commentText.scrollHeight > commentText.clientHeight) {
            if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
                e.stopPropagation()
                e.preventDefault()
                commentText.scrollBy({ top: e.deltaY, behavior: 'auto' })
            }
        }
    }, { passive: false })

    overlay.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault()
            const videoId = activeVideoId || getVideoId()
            const commentId = timeComment.commentId
            if (videoId && commentId) {
                window.open(`https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`, '_blank')
            }
        }
    })

    return overlay
}

function getOrCreateOverlayContainer() {
    const player = getPlayer()

    // YouTube can move or rebuild the player; a container left behind is invisible
    if (overlayContainer && (!overlayContainer.isConnected || (player && !player.contains(overlayContainer)))) {
        removeOverlayContainer()
    }

    if (!overlayContainer) {
        const container = document.createElement('div')
        container.classList.add('__youtube-timestamps__overlay-container')
        container.dataset.position = OVERLAY_POSITION
        container.dataset.width = OVERLAY_WIDTH_FIT ? 'fit' : 'uniform'
        setOverlayVars(container)
        container.style.setProperty('--yt-overlay-enter', overlayMotion().enter)

        if (!player) return container   // nowhere to attach yet: don't cache it
        player.appendChild(container)
        overlayContainer = container
    }
    return overlayContainer
}

function removeOverlayContainer() {
    if (overlayContainer) {
        overlayContainer.remove()
        overlayContainer = null
    }
    activeOverlays = []
}

function waitForSelector(selector, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector)
        if (el) return resolve(el)

        const observer = new MutationObserver(() => {
            const found = document.querySelector(selector)
            if (found) {
                observer.disconnect()
                resolve(found)
            }
        })
        observer.observe(document.documentElement, { childList: true, subtree: true })

        setTimeout(() => {
            observer.disconnect()
            reject(new Error(`Timeout waiting for ${selector}`))
        }, timeoutMs)
    })
}

function addTimeComments(comments, token = loadToken) {
    if (token !== loadToken) return   // belongs to a video we have already left

    const video = getVideo()
    if (!video) {
        waitForSelector('#movie_player video', 2000)
            .then(() => addTimeComments(comments, token))
            .catch(() => {})
        return
    }

    const duration = typeof video.duration === 'number' && isFinite(video.duration) ? video.duration : NaN
    if (!duration || Number.isNaN(duration) || duration <= 0) {
        // Wait for metadata, keeping at most one such listener around
        if (pendingMeta) pendingMeta.video.removeEventListener('loadedmetadata', pendingMeta.handler)
        const handler = () => {
            video.removeEventListener('loadedmetadata', handler)
            if (pendingMeta?.handler === handler) pendingMeta = null
            addTimeComments(comments, token)
        }
        pendingMeta = { video, handler }
        video.addEventListener('loadedmetadata', handler)
        return
    }

    const bar = getOrCreateBar()
    if (!bar) return
    bar.replaceChildren()   // rebuilding must never stack a second set of stamps
    stampEntries = []
    hidePreview()

    const groupedComments = new Map()
    for (const tc of comments) {
        if (typeof tc.time !== 'number' || tc.time > duration) continue
        const timeKey = tc.time.toString()
        if (!groupedComments.has(timeKey)) groupedComments.set(timeKey, [])
        groupedComments.get(timeKey).push(tc)
    }

    for (const [timeKey, commentsAtTime] of groupedComments) {
        const time = parseFloat(timeKey)
        const stamp = createTimestampStamp(time, duration, commentsAtTime)
        bar.appendChild(stamp)
    }

    layoutBar(bar)
    hookPlayer(getPlayer())
    observePlayer(getPlayer())

    builtDuration = duration
    const beyond = comments.filter(tc => typeof tc.time === 'number' && tc.time > duration).length
    if (beyond) log(beyond, 'timestamps are later than the video length and were skipped')
    const r = bar.getBoundingClientRect()
    log('built', stampEntries.length, 'ticks for a', Math.round(duration), 's video; layer at',
        [r.left, r.top, r.width, r.height].map(Math.round).join(','))
}

// A tick is purely visual (pointer-events: none), so it can never get in the way of YouTube's
// own progress bar. Hovering is worked out from the cursor position, see findEntryAt().
function createTimestampStamp(time, videoDuration, commentsAtTime) {
    const stamp = document.createElement('div')
    stamp.classList.add('__youtube-timestamps__stamp')

    if (commentsAtTime.length > 1) {
        stamp.classList.add('__youtube-timestamps__stamp--multiple')
    }

    const fraction = time / videoDuration
    stamp.style.left = `calc(${fraction * 100}% - 2px)`

    stampEntries.push({ el: stamp, fraction, commentsAtTime, index: 0 })
    return stamp
}

// The tick closest to the cursor, if the cursor is on (or just around) the progress bar.
function findEntryAt(clientX, clientY) {
    const bar = document.querySelector('.__youtube-timestamps__bar')
    if (!bar || stampEntries.length === 0) return null

    const rect = bar.getBoundingClientRect()
    if (!(rect.width > 0)) return null
    if (clientY < rect.top - HIT_BAND_ABOVE_PX || clientY > rect.bottom + HIT_BAND_BELOW_PX) return null

    let best = null
    let bestDistance = HIT_RADIUS_PX
    for (const entry of stampEntries) {
        const distance = Math.abs(clientX - (rect.left + entry.fraction * rect.width))
        if (distance <= bestDistance) {
            best = entry
            bestDistance = distance
        }
    }
    return best
}

function setHoveredEntry(entry) {
    if (entry === hoveredEntry) return
    if (!entry) {
        hidePreview()
        return
    }

    hoveredEntry?.el.classList.remove('__youtube-timestamps__stamp--hover')
    hoveredEntry = entry
    hoveredStamp = entry.el
    entry.el.classList.add('__youtube-timestamps__stamp--hover')
    showPreview(entry.commentsAtTime[entry.index], entry.commentsAtTime.length, entry.index)
}

function onPlayerMouseMove(event) {
    if (!commentsReady || !getVideoId()) return
    const entry = findEntryAt(event.clientX, event.clientY)
    if (DEBUG && !entry) logHoverMiss(event)
    setHoveredEntry(entry)
}

// Debug only: when the cursor is on the progress bar but no tick is hit, say where everything is
function logHoverMiss(event) {
    const now = Date.now()
    if (now - lastHoverLog < 1500) return
    const bar = document.querySelector('.__youtube-timestamps__bar')
    const rect = bar?.getBoundingClientRect()
    if (!rect || Math.abs(event.clientY - (rect.top + rect.height / 2)) > 40) return
    lastHoverLog = now
    log('cursor near the progress bar but not on a tick', JSON.stringify({
        cursor: [event.clientX, event.clientY],
        layer: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
        display: bar.style.display || 'shown',
        tickX: stampEntries.map(e => Math.round(rect.left + e.fraction * rect.width))
    }))
}

function onPlayerMouseLeave() {
    setHoveredEntry(null)
}

function onPlayerAuxClick(event) {
    if (event.button !== 1 || !hoveredEntry) return
    event.preventDefault()
    event.stopPropagation()
    openCommentInNewTab(hoveredEntry.commentsAtTime[hoveredEntry.index])
}

const throttledWheel = withWheelThrottle((deltaY) => {
    const entry = hoveredEntry
    if (!entry) return
    handleWheelNavigation(deltaY, entry.commentsAtTime, entry.index, (newIndex) => {
        entry.index = newIndex
    })
})

function onPlayerWheel(event) {
    if (!hoveredEntry) return
    throttledWheel(event)
}

function hookPlayer(player) {
    if (!player || hookedPlayers.has(player)) return
    hookedPlayers.add(player)
    player.addEventListener('mousemove', onPlayerMouseMove, true)
    player.addEventListener('mouseleave', onPlayerMouseLeave)
    player.addEventListener('wheel', onPlayerWheel, { capture: true, passive: false })
    player.addEventListener('auxclick', onPlayerAuxClick, true)
    log('hooked player mouse handling')
}

function handleWheelNavigation(deltaY, commentsAtTime, currentIndex, updateIndex) {
    const SWITCH_THRESHOLD = WHEEL_SWITCH_THRESHOLD
    const preview = getOrCreatePreview()
    const textElement = preview.querySelector('.__youtube-timestamps__preview__text')

    if (!preview || preview.style.display === 'none') {
        showPreview(commentsAtTime[currentIndex], commentsAtTime.length, currentIndex)
        return
    }

    const switchTo = (newIndex) => {
        updateIndex(newIndex)
        showPreview(commentsAtTime[newIndex], commentsAtTime.length, newIndex)
        const newText = document.querySelector('.__youtube-timestamps__preview__text')
        if (newText) newText.scrollTop = 0
    }

    if (textElement && textElement.scrollHeight > textElement.clientHeight) {
        const atTop = textElement.scrollTop <= SCROLL_TOLERANCE
        const atBottom = (textElement.scrollTop + textElement.clientHeight) >= (textElement.scrollHeight - SCROLL_TOLERANCE)

        if ((deltaY > 0 && !atBottom) || (deltaY < 0 && !atTop)) {
            textElement.scrollBy({ top: deltaY, left: 0, behavior: 'auto' })
            return
        }

        if (commentsAtTime.length > 1 && Math.abs(deltaY) >= SWITCH_THRESHOLD) {
            const direction = deltaY > 0 ? 1 : -1
            const newIndex = (currentIndex + direction + commentsAtTime.length) % commentsAtTime.length
            switchTo(newIndex)
        }
        return
    }

    if (commentsAtTime.length > 1 && Math.abs(deltaY) >= SWITCH_THRESHOLD) {
        const direction = deltaY > 0 ? 1 : -1
        const newIndex = (currentIndex + direction + commentsAtTime.length) % commentsAtTime.length
        switchTo(newIndex)
    }
}

function createDebouncedCommentOpener() {
    let lastOpenedAt = 0
    const DEBOUNCE_MS = WHEEL_DEBOUNCE_MS

    return (comment) => {
        const now = Date.now()
        if (now - lastOpenedAt < DEBOUNCE_MS) return
        lastOpenedAt = now

        const videoId = activeVideoId || getVideoId()
        const commentId = comment?.commentId
        if (videoId && commentId) {
            window.open(`https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`, '_blank')
        }
    }
}

// Our tick layer is a child of the controls container, next to the progress bar rather than
// inside it: YouTube empties and rebuilds the progress bar's own children at will.
function getBarMountPoint(player) {
    return player?.querySelector('.ytp-chrome-bottom') || player || null
}

function getOrCreateBar() {
    const mount = getBarMountPoint(getPlayer())
    if (!mount) return null

    let bar = mount.querySelector(':scope > .__youtube-timestamps__bar')
    if (!bar) {
        bar = document.createElement('div')
        bar.classList.add('__youtube-timestamps__bar')
        mount.insertAdjacentElement('afterbegin', bar)
        log('mounted tick layer in', mount.className || mount.tagName)
    }
    return bar
}

// Sizes the layer to sit exactly on YouTube's progress bar, whatever the player layout is.
function layoutBar(bar) {
    const progressBar = getProgressBar()
    const parent = bar.parentElement
    if (!progressBar || !parent) return

    const pb = progressBar.getBoundingClientRect()
    if (!(pb.width > 0)) return
    const pr = parent.getBoundingClientRect()
    if (!(pr.width > 0)) return   // controls hidden (e.g. player still in miniplayer layout): try again later

    const left = pb.left - pr.left
    const top = pb.top - pr.top
    const height = Math.max(pb.height, 3)
    const key = [left, top, pb.width, height].map(Math.round).join(',')
    if (bar.dataset.layout === key) return

    bar.dataset.layout = key
    log('tick layer layout', key, '| progress bar inside our controls:', parent.contains(progressBar))
    bar.style.left = left + 'px'
    bar.style.top = top + 'px'
    bar.style.width = pb.width + 'px'
    bar.style.height = height + 'px'
}

function removeBar() {
    document.querySelectorAll('.__youtube-timestamps__bar').forEach(bar => bar.remove())
    stampEntries = []
    hidePreview()
}

// Once the miniplayer has been used the player can contain more than one .ytp-progress-bar
// (the miniplayer's comes first and is hidden again on the watch page). Measuring that one
// puts the tick layer in the wrong place, so prefer the visible one inside the main controls.
function getProgressBar(player = getPlayer()) {
    if (!player) return null
    const all = [...player.querySelectorAll('.ytp-progress-bar')]
    const shown = (el) => el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0
    return all.find(el => el.closest('.ytp-chrome-bottom') && shown(el))
        || all.find(el => shown(el))
        || all.find(el => el.closest('.ytp-chrome-bottom'))
        || all[0]
        || null
}

function isElementVisible(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
}

// YouTube's own hover tooltip (time + thumbnail), but only while it is actually on screen.
// The preview does not depend on it: it is used as an anchor so the preview can sit above it.
function getTooltip() {
    const player = getPlayer()
    if (!player) return null
    for (const tooltip of player.querySelectorAll('.ytp-tooltip')) {
        if (isElementVisible(tooltip)) return tooltip
    }
    return null
}

function getTooltipBgWidth() {
    const tooltip = getTooltip()
    const tooltipBg = tooltip?.querySelector('.ytp-tooltip-bg')
    if (tooltipBg) {
        const rect = tooltipBg.getBoundingClientRect()
        if (rect?.width > 0) return rect.width
    }

    const progressBar = getProgressBar()
    const rect = progressBar?.getBoundingClientRect()
    return rect?.width > 0 ? rect.width * 0.9 : PREVIEW_DEFAULT_WIDTH
}

function applyPreviewWidth(preview, measuredWidth) {
    let w = measuredWidth + PREVIEW_WIDTH_PADDING

    const computed = window.getComputedStyle(preview)
    const minW = parseFloat(computed.minWidth) || 0
    const maxW = parseFloat(computed.maxWidth) || Infinity

    if (minW > 0) w = Math.max(w, minW)
    if (maxW > 0 && isFinite(maxW)) w = Math.min(w, maxW)

    preview.style.width = Math.round(w) + 'px'
}

function showPreview(timeComment, totalComments = 1, currentIndex = 0) {
    if (!getPlayer()) return

    const preview = getOrCreatePreview()
    preview.style.display = ''
    preview.style.transform = 'translateY(0) scale(1)'

    preview.querySelector('.__youtube-timestamps__preview__avatar').src = timeComment.authorAvatar || ''
    fillAuthorName(preview.querySelector('.__youtube-timestamps__preview__name'), timeComment)

    const metaNode = preview.querySelector('.__youtube-timestamps__preview__meta')
    const metaText = buildMetaText(timeComment)
    metaNode.textContent = metaText
    metaNode.style.display = metaText ? '' : 'none'

    const textNode = preview.querySelector('.__youtube-timestamps__preview__text')
    textNode.innerHTML = ''

    const rawText = timeComment.text || ''
    const trimmedText = rawText.trim()
    const safeText = trimmedText || '(no comment text)'
    const safeFragment = timeComment.timestamp || ''

    // trim() removes leading whitespace, so formatting offsets have to move with it
    const leadingTrimmed = rawText.length - rawText.trimStart().length
    const shiftRuns = (runs) => trimmedText
        ? (runs || []).map(r => ({ ...r, start: r.start - leadingTrimmed, end: r.end - leadingTrimmed }))
        : []
    const styles = shiftRuns(timeComment.styles)
    const emojis = shiftRuns(timeComment.emojis)

    textNode.style.opacity = safeText === '(no comment text)' ? '0.88' : '1'
    textNode.appendChild(highlightTextFragment(safeText, safeFragment, styles, emojis))

    const navIndicator = preview.querySelector('.__youtube-timestamps__preview__nav')
    if (totalComments > 1) {
        navIndicator.textContent = `${currentIndex + 1} of ${totalComments} comments`
        navIndicator.style.display = 'block'
    } else {
        navIndicator.style.display = 'none'
    }

    const measured = getTooltipBgWidth()
    applyPreviewWidth(preview, measured)

    // The card is a flex column (see CSS): header and button keep their size, the text area takes
    // what is left and scrolls. Only the cap needs setting. It grows by however much taller the header
    // got from the stats line (the avatar already makes the header 24px), so the text area is exactly
    // as tall with stats as without.
    const headerNode = preview.querySelector('.__youtube-timestamps__preview__author')
    const statsExtra = Math.max(0, headerNode.offsetHeight - PREVIEW_AVATAR_SIZE)
    preview.style.height = ''
    preview.style.minHeight = PREVIEW_MIN_HEIGHT + 'px'
    preview.style.maxHeight = (PREVIEW_MAX_HEIGHT + PREVIEW_MARGINS_TOTAL + statsExtra) + 'px'

    preview.dataset.measuredWidth = String(Math.round(measured))
    layoutPreview(preview)
    startPreviewLayoutLoop()
}

// Places the preview above the hovered stamp, clamped to the progress bar, and above YouTube's
// thumbnail tooltip when that is showing. Everything is measured from the live DOM each time.
function layoutPreview(preview) {
    const player = getPlayer()
    const progressBar = getProgressBar(player)
    if (!player || !progressBar) return

    const playerRect = player.getBoundingClientRect()
    const barRect = progressBar.getBoundingClientRect()
    const tooltip = getTooltip()
    const tooltipRect = tooltip ? tooltip.getBoundingClientRect() : null

    const measured = getTooltipBgWidth()
    if (String(Math.round(measured)) !== preview.dataset.measuredWidth) {
        applyPreviewWidth(preview, measured)
        preview.dataset.measuredWidth = String(Math.round(measured))
    }
    const width = preview.getBoundingClientRect().width || measured
    const half = width / 2

    let centerX
    if (hoveredStamp?.isConnected) {
        const stampRect = hoveredStamp.getBoundingClientRect()
        centerX = stampRect.left + stampRect.width / 2
    } else if (tooltipRect) {
        centerX = tooltipRect.left + tooltipRect.width / 2
    } else {
        centerX = barRect.left + barRect.width / 2
    }
    centerX = Math.min(Math.max(centerX, barRect.left + half), barRect.right - half)

    const anchorTop = tooltipRect && tooltipRect.height > 0 ? tooltipRect.top : barRect.top

    preview.style.left = Math.round(centerX - half - playerRect.left - PREVIEW_BORDER_SIZE) + 'px'
    preview.style.bottom = Math.round(playerRect.bottom - anchorTop + PREVIEW_MARGIN + PREVIEW_TOOLTIP_MARGIN) + 'px'
}

// Keeps the preview in place while it is visible (mouse moves, thumbnail loads, resize, fullscreen).
function startPreviewLayoutLoop() {
    if (previewRaf) return
    const tick = () => {
        previewRaf = 0
        const preview = document.querySelector('.__youtube-timestamps__preview')
        if (!preview || preview.style.display === 'none' || !preview.isConnected) return

        // A stamp that was rebuilt while hovered never gets its mouseleave
        if (hoveredStamp && !hoveredStamp.isConnected) {
            hidePreview()
            return
        }
        layoutPreview(preview)
        previewRaf = requestAnimationFrame(tick)
    }
    previewRaf = requestAnimationFrame(tick)
}

// The preview lives in our own layer inside the player, not inside YouTube's tooltip.
function getOrCreatePreview() {
    const player = getPlayer()
    if (!player) return document.createElement('div')

    document.querySelectorAll('.__youtube-timestamps__preview-host').forEach(host => {
        if (host.parentElement !== player) host.remove()
    })

    let host = player.querySelector(':scope > .__youtube-timestamps__preview-host')
    if (!host) {
        host = document.createElement('div')
        host.classList.add('__youtube-timestamps__preview-host')
        player.appendChild(host)
    }

    let preview = host.querySelector('.__youtube-timestamps__preview')
    if (!preview) {
        preview = createPreviewElement()
        host.appendChild(preview)
    }
    return preview
}

function createPreviewElement() {
    const preview = document.createElement('div')
    preview.classList.add('__youtube-timestamps__preview')

    const authorElement = document.createElement('div')
    authorElement.classList.add('__youtube-timestamps__preview__author')
    preview.appendChild(authorElement)

    const avatarElement = document.createElement('img')
    avatarElement.classList.add('__youtube-timestamps__preview__avatar')
    authorElement.appendChild(avatarElement)

    // Name and the gray stats line form one column, so the avatar centres against both of them
    const whoElement = document.createElement('div')
    whoElement.classList.add('__youtube-timestamps__preview__who')
    authorElement.appendChild(whoElement)

    const nameElement = document.createElement('span')
    nameElement.classList.add('__youtube-timestamps__preview__name')
    whoElement.appendChild(nameElement)

    const metaElement = document.createElement('div')
    metaElement.classList.add('__youtube-timestamps__preview__meta')
    metaElement.style.display = 'none'
    whoElement.appendChild(metaElement)

    const textElement = document.createElement('div')
    textElement.classList.add('__youtube-timestamps__preview__text')
    preview.appendChild(textElement)

    const navElement = document.createElement('div')
    navElement.classList.add('__youtube-timestamps__preview__nav')
    navElement.style.display = 'none'
    preview.appendChild(navElement)

    textElement.addEventListener('wheel', (ev) => {
        if (textElement.scrollHeight > textElement.clientHeight) {
            if (ev.cancelable) ev.preventDefault()
            textElement.scrollBy({ top: ev.deltaY, left: 0, behavior: 'auto' })
        }
    }, { passive: false })

    return preview
}

function highlightTextFragment(text, fragment, styles, emojis) {
    const safeText = String(text)
    const safeFragment = String(fragment)

    return createStyledFragment(safeText, styles, (ts) => {
        const isActive = !!safeFragment && ts === safeFragment
        if (!isActive && parseTimestampToSeconds(ts) == null) return null

        const span = document.createElement('span')
        span.classList.add(isActive
            ? '__youtube-timestamps__preview__text-stamp'
            : '__youtube-timestamps__preview__text-link')
        return span
    }, emojis)
}

function hidePreview() {
    hoveredEntry?.el.classList.remove('__youtube-timestamps__stamp--hover')
    hoveredEntry = null
    hoveredStamp = null
    document.querySelectorAll('.__youtube-timestamps__preview').forEach(preview => {
        preview.style.display = 'none'
    })
}

function withWheelThrottle(callback) {
    let deltaYAcc = 0
    let afRequested = false

    return (e) => {
        e.stopPropagation()
        if (e.cancelable) e.preventDefault()
        deltaYAcc += e.deltaY

        if (afRequested) return
        afRequested = true

        window.requestAnimationFrame(() => {
            callback(deltaYAcc)
            deltaYAcc = 0
            afRequested = false
        })
    }
}

function parseParams(href) {
    const paramString = href.split('#')[0].split('?')[1]
    const params = {}

    if (paramString) {
        for (const kv of paramString.split('&')) {
            const [key, value] = kv.split('=')
            params[key] = value
        }
    }
    return params
}

// Navigation events only *nudge* sync(); the timer below is the safety net for when YouTube
// changes the page without firing them (or fires them in an unexpected order).
window.addEventListener('yt-navigate-start', () => {
    hidePreview()
})

window.addEventListener('yt-navigate-finish', () => {
    sync()
})

window.addEventListener('popstate', () => {
    sync()
})

// timeupdate doesn't bubble, but a capture listener on document sees it from any <video>.
// This survives YouTube swapping or re-parenting the video element (miniplayer, ads...).
document.addEventListener('timeupdate', (event) => {
    const target = event.target
    if (!commentsReady || !target || target.tagName !== 'VIDEO' || !target.closest('#movie_player')) return
    handleTimeUpdate(event)
}, true)

window.addEventListener('resize', scheduleReattach)
document.addEventListener('fullscreenchange', scheduleReattach)

setInterval(() => {
    if (!document.hidden) sync()
}, WATCHDOG_INTERVAL_MS)

sync()