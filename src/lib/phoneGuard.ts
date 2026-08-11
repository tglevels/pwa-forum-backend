// Phone-number detection & redaction for forum content (comments).
// Same regex as tglevel_mobile_pwa's ForumPostDetail.jsx (PHONE_RE) — the two
// packages have no shared module, so keep them in sync when changing either.
//
// Indian mobile numbers: 10 digits starting 6-9, optionally prefixed with +91
// or a leading 0, digits separated by single spaces/dashes in any grouping
// (e.g. 98765 43210, 987-654-3210, 91234 56789).
const PHONE_RE = /(?<!\d)(?:\+?91[ \t-]?)?(?:0[ \t-]?)?[6-9]\d{2}(?:[ \t-]?\d){7}(?!\d)/g;

// Non-global copy for .test() — a /g regex's test() advances lastIndex and
// would return alternating results across calls.
const PHONE_RE_TEST = new RegExp(PHONE_RE.source);

// Redaction marker — a visible placeholder instead of a silent gap so readers
// know the contact info was removed (matches the client's behavior).
export const PHONE_REDACTED_MARKER = '[phone number removed]';

export function containsPhoneNumber(text: string): boolean {
  return PHONE_RE_TEST.test(String(text ?? ''));
}

export function stripPhoneNumbers(text: string): string {
  return String(text ?? '')
    .replace(PHONE_RE, PHONE_REDACTED_MARKER)
    .replace(/\s{2,}/g, ' ')
    .trim();
}
