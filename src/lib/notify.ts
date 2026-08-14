// Fire-and-forget calls to PWA_NOTIFY, the same way pwa-node-backend's
// send-message route does today. Scope stays narrow per the plan: mentions
// and new admin posts only — not votes or every reply.
const PWA_NOTIFY_URL = process.env.PWA_NOTIFY_URL || 'http://localhost:3001';
// Origin the forum service's /upload media is publicly reachable at — used to
// resolve the relative media_url into an absolute one the browser's
// notification renderer can fetch (mirrors the PWA's resolveForumMediaUrl).
const FORUM_BASE_URL = process.env.FORUM_BASE_URL || 'http://localhost:3006';

function absoluteForumUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return `${FORUM_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Push notification bodies render as plain text (lock screen, notification
// tray) — a title composed with the RA's rich text editor may carry
// <strong>/<em> tags that would otherwise show up literally.
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

export function notifyNewPost(post: {
  id: number;
  title: string;
  ra_display_name?: string;
  media_url?: string | null;
  media_type?: string | null;
}) {
  fetch(`${PWA_NOTIFY_URL}/notify-forum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_post',
      post_id: post.id,
      title: stripHtml(post.title),
      actor_name: post.ra_display_name,
      // Only image posts get a notification image (videos have no poster here).
      image_url: post.media_type === 'image' ? absoluteForumUrl(post.media_url) : undefined,
    }),
  }).catch((err) => console.warn('[notify-forum] new_post trigger failed (non-fatal):', err.message));
}

export function notifyMention(params: {
  mentionedUserId: string;
  postId: number;
  commentId: number;
  commentBody?: string;
  actorName?: string;
}) {
  fetch(`${PWA_NOTIFY_URL}/notify-forum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mention',
      user_id: params.mentionedUserId,
      post_id: params.postId,
      comment_id: params.commentId,
      body: stripHtml(params.commentBody || ''),
      actor_name: params.actorName,
      mentioned_user_type: 'user',
    }),
  }).catch((err) => console.warn('[notify-forum] mention trigger failed (non-fatal):', err.message));
}

// Official (@Tglevels) mentions route to the admin RA instead of an end user.
// PWA_NOTIFY treats ra mentions as in-app only (RAs have no push
// subscriptions), so this fires to keep its notification_log consistent — the
// real-time surface is the user:{adminRaId} socket room + forum_notifications row.
export function notifyOfficialMention(params: {
  adminRaId: string;
  postId: number;
  commentId: number;
  actorName?: string;
}) {
  fetch(`${PWA_NOTIFY_URL}/notify-forum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mention',
      user_id: params.adminRaId,
      post_id: params.postId,
      comment_id: params.commentId,
      body: '',
      actor_name: params.actorName,
      mentioned_user_type: 'ra',
    }),
  }).catch((err) => console.warn('[notify-forum] official mention trigger failed (non-fatal):', err.message));
}
