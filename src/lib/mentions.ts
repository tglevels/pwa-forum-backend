// Extracts @mentions from comment body text. Mentions are authored as
// @user_id (the client resolves a display name to a user_id before sending,
// same trust boundary as the rest of comment authorship).
export function extractMentions(body: string): string[] {
  const matches = body.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const ids = matches.map((m) => m.slice(1));
  return Array.from(new Set(ids));
}
