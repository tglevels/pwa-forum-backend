// URL/link detection & redaction for forum content (comments).
// Same regex as tglevel_mobile_pwa's ForumPostDetail.jsx (LINK_RE) — the two
// packages have no shared module, so keep them in sync when changing either.
//
// Matches protocol links (https://…, http://…), www-prefixed domains and bare
// domains with a dot + TLD, including paths (e.g. https://www.google.com/,
// www.example.com/page, example.co.in).
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s<>"')\]]*)?/gi;

// Non-global copy for .test() — a /g regex's test() advances lastIndex and
// would return alternating results across calls.
const LINK_RE_TEST = new RegExp(LINK_RE.source);

// Redaction marker — a visible placeholder instead of a silent gap so readers
// know the link was removed (matches the client's behavior).
export const LINK_REDACTED_MARKER = '[link removed]';

export function containsLink(text: string): boolean {
  return LINK_RE_TEST.test(String(text ?? ''));
}

export function stripLinks(text: string): string {
  return String(text ?? '')
    .replace(LINK_RE, LINK_REDACTED_MARKER)
    .replace(/\s{2,}/g, ' ')
    .trim();
}
