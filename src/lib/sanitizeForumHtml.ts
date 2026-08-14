import sanitizeHtml from 'sanitize-html';

// The RA composer (TG-RA-Frontend) now writes rich text via TipTap, storing
// its HTML output straight into title/body. This is the server-side
// chokepoint that guards every downstream renderer (RA-frontend's admin
// view, the mobile PWA's feed/detail pages, push-notification payloads)
// against stored XSS — sanitize on the way in, not on every way out.

// Body: block + inline formatting, no media/scripts/embeds.
const BODY_ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'h2', 'h3'];
const BODY_ALLOWED_ATTR = { a: ['href'] };

// Title: inline-only — no block/list/link tags, since every surface that
// displays a title treats it as a single line (feed cards, list rows).
const TITLE_ALLOWED_TAGS = ['strong', 'b', 'em', 'i', 'u', 's', 'br'];

const ALLOWED_SCHEMES = ['http', 'https', 'mailto'];

export function sanitizeForumBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: BODY_ALLOWED_TAGS,
    allowedAttributes: BODY_ALLOWED_ATTR,
    allowedSchemes: ALLOWED_SCHEMES,
  });
}

export function sanitizeForumTitle(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: TITLE_ALLOWED_TAGS,
    allowedAttributes: {},
  });
}

// Plain-text length of an HTML string — used to enforce the title's 500-char
// cap without truncating mid-tag (a naive string .slice(0, 500) on HTML can
// cut a tag in half and corrupt the markup).
export function plainTextLength(html: string): number {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).length;
}
