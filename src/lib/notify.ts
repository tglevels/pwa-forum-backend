// Fire-and-forget calls to PWA_NOTIFY, the same way pwa-node-backend's
// send-message route does today. Scope stays narrow per the plan: mentions
// and new admin posts only — not votes or every reply.
const PWA_NOTIFY_URL = process.env.PWA_NOTIFY_URL || 'http://localhost:3001';

export function notifyNewPost(post: { id: number; title: string; ra_display_name?: string }) {
  fetch(`${PWA_NOTIFY_URL}/notify-forum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_post',
      post_id: post.id,
      title: post.title,
      actor_name: post.ra_display_name,
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
      event: 'mention',
      comment_id: params.commentId,
      post_id: params.postId,
      body: params.commentBody || '',
      mentioned_user_id: params.mentionedUserId,
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
      event: 'mention',
      comment_id: params.commentId,
      post_id: params.postId,
      body: '',
      mentioned_user_id: params.adminRaId,
      mentioned_user_type: 'ra',
    }),
  }).catch((err) => console.warn('[notify-forum] official mention trigger failed (non-fatal):', err.message));
}
