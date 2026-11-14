// What counts as a timestamp in a comment. The rules were read off a real YouTube thread where the
// coloured text is what YouTube itself treats as a timestamp:
//
//   - M:SS or H:MM:SS. The first number has 1-2 digits ("0:00", "10:00" yes; "000:01", "100:00" no),
//     every other number has exactly 2 digits and is at most 59 ("0:1", "1:9", "0:60", "9:99" no).
//   - Only ASCII digits and an ASCII colon ("０：３０", "0;30", "0,30", "0 : 30", "0:\n30" are not).
//   - It must not continue a longer number: no digit directly before it ("1230:30", "123:456") or
//     after it ("0:050:100:15"), and "0:30%" is not one either.
//   - Letters, punctuation, emoji and signs around it are fine ("x0:30y", "(0:15)", "-0:05").
//   - Text inside a link is part of the link ("https://example.com/watch/0:30").
//
// Not covered by the screenshots, so assumed: "0:00: Intro" counts (a colon after it is only a
// continuation when a digit follows), "1:2:30" does not, and minutes may go up to 99 in M:SS
// ("75:30" in a long video).
//
// content/content.js has the same function for colouring text; keep the two identical.
const TIMESTAMP_SOURCE =
	"(?<!\\d)(?<!\\d:)(?:\\d{1,2}:[0-5]\\d:[0-5]\\d|\\d{1,2}:[0-5]\\d)(?![\\d%])(?!:\\d)";
const URL_SOURCE = "\\b(?:https?:\\/\\/|www\\.)\\S+";

// [{ from, to }] for every timestamp in the text, in order
export function findTimestamps(text) {
	const urls = [];
	const urlPattern = new RegExp(URL_SOURCE, "gi");
	let match;
	while ((match = urlPattern.exec(text))) {
		urls.push([match.index, match.index + match[0].length]);
	}

	const result = [];
	const pattern = new RegExp(TIMESTAMP_SOURCE, "g");
	while ((match = pattern.exec(text))) {
		const from = match.index;
		const to = from + match[0].length;
		if (urls.some(([a, b]) => from < b && to > a)) continue;
		result.push({ from, to });
	}
	return result;
}

export function parseTimestamp(ts) {
	const parts = ts.split(":").map((p) => parseInt(p, 10));
	if (parts.some((p) => Number.isNaN(p))) return null;
	if (parts.length === 2) {
		const [m, s] = parts;
		return s > 59 ? null : m * 60 + s;
	}
	if (parts.length === 3) {
		const [h, m, s] = parts;
		return m > 59 || s > 59 ? null : h * 3600 + m * 60 + s;
	}
	return null;
}

export function getTimestampContexts(text) {
	const result = [];
	for (const position of findTimestamps(text)) {
		const timestamp = text.substring(position.from, position.to);
		const time = parseTimestamp(timestamp);
		if (time === null) continue;
		result.push({ text, time, timestamp });
	}
	return result;
}
