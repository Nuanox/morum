/** Pure helpers for talking about web.archive.org snapshot URLs -- no
 * fetching here, so these are unit-testable without a network. */

/** Matches an `archive_url_hint` already pointing at a Wayback snapshot,
 * e.g. https://web.archive.org/web/20230101120000/https://example.org/a
 * or   https://web.archive.org/web/20230101120000id_/https://example.org/a
 * Returns {timestamp, url} or null when it does not match. */
export function parseArchiveUrlHint(hint){
 if(typeof hint!=='string')return null;
 const m=/^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z_]+)?\/(.+)$/.exec(hint);
 if(!m)return null;
 return {timestamp:m[1],url:m[2]};
}

/** Builds the `id_` raw-content snapshot URL the job fetches from. */
export function snapshotUrl(timestamp,url){
 return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

/** Formats a Date (or ISO string) as the YYYYMMDDhhmmss timestamp the
 * Wayback "available" API and snapshot URLs expect, in UTC. */
export function toWaybackTimestamp(when){
 const d=when instanceof Date?when:new Date(when);
 const pad=(n,w=2)=>String(n).padStart(w,'0');
 return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`+
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Builds the `wayback/available` lookup URL for a target url + timestamp. */
export function availableUrl(url,timestamp){
 return `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${timestamp}`;
}
