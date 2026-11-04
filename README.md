TODO: this codebase is beyond saving 😭
- [x] Add options to remove timestamps and/or comment overlays with n amount of timestamps to root out all certain comments that list out chapters, this moment, etc... which could clog up visual space and be unnecessary.
- [x] Only current timestamp glows when a comment overlay has multiple timestamps.
- [x] Make comment overlays that are long scroll to display more text, similar to preview.
- [x] Add options to change comment overlay position from top left to other directions.
- [x] Add options to change the direction the comment overlay is appearing and disappearing.
- [x] Add options to change comment overlay size in normal/full screen.
- [x] Option to turn on/off comment overlay's width changes in uniform with other comment overlays.
- [x] When a comment overlay disappears, the other comment overlays suddenly go up, no animation. Only the when appearing does any comment overlay have animation.
- [x] When in full screen and scrolling through a timestamp, add-on should still scroll that timestamp instead of YouTube's More videos.
- [x] Fix 1 of n comment (comments that share a timestamp) UI clipping at the bottom (not perfect but will fix it again).
- [x] Fix add-on not appearing unless user manually refresh YouTube tab once (fuck YouTube SPA).
- [x] `(*)` Show other data like display name, likes, replies, etc... and options to show/hide them the options menu. Maybe? ([return-yt-comment-usernames](https://github.com/Frank0945/return-yt-comment-usernames/blob/main/src/injected.ts), view code below)
- [x] Add `<optgroup>` for selection boxes!
- [x] Change timestamp bar to a circle to mimic YouTube's (on mobile, on videos that have Timed comments).
- [ ] Remove "Pull up for precise thinking". Maybe.
- [ ] Current method of showing comments is [Discord-esque](https://www.reddit.com/r/discordapp/comments/1j746ke/new_overlay_notification_please_tell_me_how_to/). Maybe add a new option to change it to [Soundcloud-esque](https://assemblethenoise.wordpress.com/2014/06/21/a-soundcloud-comments-experiment/)? (but it would mean i have to somehow make the seek/progress bar visible!)
- [x] Fix preview and comment overlays with formatted text (bold, italic, strikethrough) rendering as normal text.
- [x] Fix miniplayer breaking add-on.
- [x] Fix YouTube's custom emojis not rendering as images (because YouTube treats Unicode and custom emojis as images) but as text.
- [x] Add support for replies and option to exclude them.
- [x] Remove support for embedded videos (`/embed`).
- [ ] Give users the ability to choose between Innertube and YouTube Data API. Innertube is "plug-and-play" but can only fetch the first `maxResults` comments and replies, while YouTube Data API requires users to input their key through Google Cloud Console but fetches all comments of a video.
- [ ] Checks the first `maxResults` comments for timestamps... what if it checks for all comments and only get the first `maxResults` of those comments?
> Material/Reference: [Youtube Timeline](https://chromewebstore.google.com/detail/jjhifobmdjhlphmilfmemefedpkmhdnb), [TimeComments](https://chromewebstore.google.com/detail/djcmgmddnajefejhjhfhlfljoofplmlo), [CommenTime](https://addons.mozilla.org/addon/commentime)
- [ ] Refactor codebase to make development easier (and migrate some of the consts at the top in `content.js` to `content.css`; it's a hot mess 😵‍💫).
- [ ] Make some UI adjustments in `content.css` and `options.html`.

> Others: [Highlights for YouTube](https://chromewebstore.google.com/detail/highlights-for-youtube/jahmafmcpgdedfjfknmfkhaiejlfdcfc), [Scrubber: YouTube Comment Timestamps](https://chromewebstore.google.com/detail/scrubber-youtube-comment/jhhcdmdpkdlkdpklaogdbknnciapcfah)

---

Videos to test and stress test this add-on to its limit:
- https://www.youtube.com/watch?v=RbcPK4yAdHU
- https://www.youtube.com/watch?v=_OgR98kqTJU
- https://www.youtube.com/watch?v=-FTNbqxCfhA
- https://www.youtube.com/watch?v=Z10GH-6IX1M

---

For the `(*)` checkbox. Test what Innertube returns: (`node [FILE_NAME].mjs`)
```
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"
const INNERTUBE_CLIENT_NAME = "WEB"
const INNERTUBE_CLIENT_VERSION = "2.20211129.09.00"

const VIDEO_ID = "dQw4w9WgXcQ" // rickroll cuz y not

async function main() {
    const videoRes = await fetch(`https://www.youtube.com/watch?v=${VIDEO_ID}&pbj=1`, {
        headers: {
            "X-Youtube-Client-Name": "1",
            "X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION
        }
    })
    const videoData = await videoRes.json()

    const response = Array.isArray(videoData)
        ? videoData.find(e => e.response).response
        : videoData.response

    const token = response
        .contents.twoColumnWatchNextResults.results.results
        .contents.find(e => e.itemSectionRenderer?.sectionIdentifier === 'comment-item-section')
        .itemSectionRenderer.contents[0].continuationItemRenderer
        ?.continuationEndpoint.continuationCommand.token

    const body = {
        context: {
            client: {
                clientName: INNERTUBE_CLIENT_NAME,
                clientVersion: INNERTUBE_CLIENT_VERSION
            }
        },
        continuation: token
    }

    const commentsRes = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    })

    const commentsData = await commentsRes.json()

    import('fs').then(fs => {
        fs.writeFileSync('response.json', JSON.stringify(commentsData, null, 2))
    })
}

main().catch(console.error)
```

Example of `response.json`:
```
"payload": {
            "commentEntityPayload": {
              "key": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyAoKAE%3D",
              "properties": {
                "commentId": "Ugzge340dBgB75hWBm54AaABAg",
                "content": {
                  "content": "can confirm: he never gave us up"
                },
                "publishedTime": "10 months ago",
                "replyLevel": 0,
                "authorButtonA11y": "@YouTube",
                "toolbarStateKey": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyAsKAE%3D",
                "translateButtonEntityKey": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyD_ASgB"
              },
              "author": {
                "channelId": "UCBR8-60-B28hp2BmDPdntcQ",
                "displayName": "@YouTube",
                "avatarThumbnailUrl": "https://yt3.ggpht.com/3s6evpqAiDU9tQR4sC2siJippbH2RWVPnwHgyl4V0th2iuQz0VDQZbUhQBGmsxLYo-mjG6TqZQ=s88-c-k-c0x00ffffff-no-rj",
                "isVerified": true,
                "isCurrentUser": false,
                "isCreator": false,
                "channelCommand": {
                  "innertubeCommand": {
                    "clickTrackingParams": "CGEQtnUY____________ASITCMDw75G19JIDFVSBuQUd6mAFSMoBBJ6leJo=",
                    "commandMetadata": {
                      "webCommandMetadata": {
                        "url": "/@YouTube",
                        "webPageType": "WEB_PAGE_TYPE_CHANNEL",
                        "rootVe": 3611,
                        "apiUrl": "/youtubei/v1/browse"
                      }
                    },
                    "browseEndpoint": {
                      "browseId": "UCBR8-60-B28hp2BmDPdntcQ",
                      "canonicalBaseUrl": "/@YouTube"
                    }
                  }
                },
                "innerBadgeA11y": "@YouTube, verified user",
                "isArtist": false
              },
              "toolbar": {
                "likeCountLiked": "188K",
                "likeCountNotliked": "188K",
                "replyCount": "961",
                "creatorThumbnailUrl": "https://yt3.ggpht.com/vewxKdtll-rntHAMDPY_Qa6hPac3-J2sCFFUwvGSSR0i7hB4g5rNfF39lCEcjGvsYI0RWx7V1A=s88-c-k-c0x00ffffff-no-rj",
                "likeButtonA11y": "Like this comment along with 188K other people",
                "engagementToolbarStyle": {
                  "value": "ENGAGEMENT_TOOLBAR_STYLE_VALUE_DEFAULT"
                },
                "likeCountA11y": "188K likes",
                "replyCountA11y": "961 replies",
                "likeInactiveTooltip": "Like",
                "likeActiveTooltip": "Unlike",
                "dislikeInactiveTooltip": "Dislike",
                "dislikeActiveTooltip": "Remove dislike",
                "heartActiveTooltip": "❤ by @RickAstleyYT"
              },
```
