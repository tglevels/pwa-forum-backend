// The reserved official account users can tag with @Tglevels. Its id is a
// string, so it can never collide with an auto-increment numeric user id, and
// it's matched BEFORE any user lookup — even a real user named "Tglevels"
// resolves to the official account, never to them.
export const OFFICIAL_HANDLE = {
  id: 'tglevels',
  name: 'Tglevels',
};

// Case-insensitive literal @tglevels token in comment text — covers bypassing
// clients that type the handle without sending the out-of-band mention id.
const OFFICIAL_MENTION_RE = /@tglevels\b/i;

export function containsOfficialMention(body: string | null | undefined): boolean {
  return OFFICIAL_MENTION_RE.test(String(body ?? ''));
}
