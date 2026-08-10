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
      actor_name: params.actorName,
    }),
  }).catch((err) => console.warn('[notify-forum] mention trigger failed (non-fatal):', err.message));
}
