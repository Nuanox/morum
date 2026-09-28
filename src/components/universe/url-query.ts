// Pure helper: decide whether a typed search query looks like a URL, for the front-page search box's
// url-report lookup (see docs/spec-url-card). Kept dependency-free so it can be unit-tested directly.

/** A bare domain: at least one dot, optional path, no scheme. Deliberately conservative — it must not
 * match ordinary words (Korean or otherwise) or things that merely contain a dot, like a version number
 * or an email address. */
const BARE_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i;

/** Returns the normalised URL (bare domains get an `https://` prefix) when `query` (already trimmed by
 * the caller, but trimmed again here defensively) looks like a URL a person might paste to ask "has this
 * been checked?" — otherwise null. */
export function isUrlQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes('@')) return null;
  if (BARE_DOMAIN_RE.test(trimmed)) return `https://${trimmed}`;
  return null;
}
