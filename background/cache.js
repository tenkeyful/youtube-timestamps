// Persistent cache of finished scans (browser.storage.local), so reopening a video, or restarting
// Firefox, costs no new requests and no quota. CommenTime and Scrubber both do this.
//
// A record holds only the comments that contain a timestamp, each stored once. The timestamps are
// found again when a record is read, so a later change to the timestamp rules also applies to
// records saved earlier. Records expire after the user's chosen time, and the whole cache is kept
// under a size and a count limit by dropping the oldest first.

const PREFIX = "scanCache:";
const INDEX_KEY = "scanCacheIndex"; // { [videoId]: { at, bytes } }
const FORMAT = 1; // bump when the record layout changes: older records are then ignored

// Exported so tests can use small limits
export const limits = { maxBytes: 8 * 1024 * 1024, maxVideos: 150 };

const HOUR = 60 * 60 * 1000;
export const TTL_CHOICES = {
	off: 0,
	"1h": HOUR,
	"6h": 6 * HOUR,
	"1d": 24 * HOUR,
	"1w": 7 * 24 * HOUR,
};

// The setting is stored as a key that is absent for the default (one day)
export function ttlMs(setting) {
	if (setting === undefined || setting === null || setting === "")
		return TTL_CHOICES["1d"];
	return TTL_CHOICES[setting] ?? TTL_CHOICES["1d"];
}

// A short fingerprint, so a record can be matched to the settings it was made with without storing
// anything sensitive (the API key is part of those settings)
export function fingerprint(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

async function readIndex() {
	try {
		const { [INDEX_KEY]: index } = await browser.storage.local.get(INDEX_KEY);
		return index && typeof index === "object" && !Array.isArray(index)
			? index
			: {};
	} catch (e) {
		return {};
	}
}

// Returns the saved record when it exists, was made with the same settings and has not expired
export async function loadCached(videoId, signature, ttl, now = Date.now()) {
	if (!(ttl > 0)) return null;
	try {
		const key = PREFIX + videoId;
		const { [key]: record } = await browser.storage.local.get(key);
		if (!record || record.format !== FORMAT) return null;
		if (record.signature !== signature) return null;
		if (!Array.isArray(record.comments)) return null;
		if (!(now - record.savedAt <= ttl)) {
			await removeVideos([videoId]);
			return null;
		}
		return record;
	} catch (e) {
		return null;
	}
}

// Returns true when the record was stored. A record that is too big for the cache, or a storage
// failure, just means the next visit scans again.
export async function saveCached(
	{ videoId, signature, comments, meta },
	ttl,
	now = Date.now(),
) {
	if (!(ttl > 0)) return false;
	try {
		const record = {
			format: FORMAT,
			videoId,
			signature,
			savedAt: now,
			meta,
			comments,
		};
		const bytes = JSON.stringify(record).length;
		if (bytes > limits.maxBytes / 2) return false; // one record must not push everything else out

		const index = await readIndex();
		index[videoId] = { at: now, bytes };

		// expired records first, then the oldest until the cache fits
		const drop = [];
		for (const [id, entry] of Object.entries(index)) {
			if (id !== videoId && !(now - entry.at <= ttl)) drop.push(id);
		}
		const alive = () =>
			Object.entries(index).filter(([id]) => !drop.includes(id));
		const byAge = () => alive().sort((a, b) => a[1].at - b[1].at);
		let total = () => alive().reduce((sum, [, e]) => sum + (e.bytes || 0), 0);
		while (
			(total() > limits.maxBytes || alive().length > limits.maxVideos) &&
			alive().length > 1
		) {
			const [oldestId] = byAge().find(([id]) => id !== videoId) ?? [];
			if (!oldestId) break;
			drop.push(oldestId);
		}
		for (const id of drop) delete index[id];

		await browser.storage.local.set({ [PREFIX + videoId]: record });
		if (drop.length)
			await browser.storage.local.remove(drop.map((id) => PREFIX + id));
		await browser.storage.local.set({ [INDEX_KEY]: index });
		return true;
	} catch (e) {
		return false;
	}
}

async function removeVideos(ids) {
	try {
		await browser.storage.local.remove(ids.map((id) => PREFIX + id));
		const index = await readIndex();
		for (const id of ids) delete index[id];
		await browser.storage.local.set({ [INDEX_KEY]: index });
	} catch (e) {
		// nothing to do: the record just stays until it is overwritten or evicted
	}
}

export async function clearCache() {
	const all = await browser.storage.local.get(null);
	const keys = Object.keys(all).filter(
		(k) => k.startsWith(PREFIX) || k === INDEX_KEY,
	);
	if (keys.length) await browser.storage.local.remove(keys);
	return keys.filter((k) => k.startsWith(PREFIX)).length;
}

// { videos, bytes } for the options page
export async function cacheStats() {
	const index = await readIndex();
	const entries = Object.values(index);
	return {
		videos: entries.length,
		bytes: entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
	};
}
