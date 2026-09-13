/**
 * Normalise a user-supplied website address to a bare hostname.
 *
 * Tracker requests are matched against this value, so it has to be canonical:
 * `https://www.Example.com/pricing?a=1` and `example.com` must both land on
 * `example.com`, or the same site would be treated as two.
 *
 * Throws when the input cannot be parsed as a URL — the caller surfaces that as
 * a 400 rather than storing an address no tracker will ever match.
 */
export function normalizeHostname(raw: string): string {
  let candidate = raw.trim();

  // `new URL` requires a scheme; assume https for a bare host. Checked
  // case-insensitively because "HTTPS://example.com" is a valid URL that would
  // otherwise get a second scheme prepended and fail to parse.
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let hostname: string;
  try {
    // `URL.hostname` already lowercases and strips port, path, query and hash.
    hostname = new URL(candidate).hostname;
  } catch {
    throw new Error("invalid website URL format");
  }

  if (hostname === "") throw new Error("invalid website URL format");

  // `www.` is a serving detail, not an identity. Stripped so a visitor on the
  // apex and one on www are attributed to the same site.
  return hostname.replace(/^www\./, "");
}
