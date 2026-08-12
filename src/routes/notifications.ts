import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumNotification } from '../models/ForumNotification';
import { ForumComment } from '../models/ForumComment';
import { RAUser } from '../models/RAUser';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

// GET /notifications — inbox for the bell icon. Supports ?since= for
// reconnect reconciliation. Rows are enriched with the commenter's name and
// the tagged comment body so clients can render a useful preview without an
// extra round-trip per row. Actor names resolve from the comment's own
// author_name (mentions) or ra_users.display_name (new posts) — the id a row
// carries is the session-uid namespace, which is not a ra_user_profiles.id.
router.get('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const { since, limit } = req.query;
    const where: any = { user_id: req.identity!.id, user_type: req.identity!.type };
    if (since) where.createdAt = { [Op.gt]: new Date(String(since)) };

    const notifications = await ForumNotification.findAll({
      where,
      order: [['id', 'DESC']],
      limit: Math.min(Number(limit) || 30, 100),
    });

    const unreadCount = await ForumNotification.count({
      where: { user_id: req.identity!.id, user_type: req.identity!.type, read_at: null },
    });

    const commentIds = notifications
      .filter((n) => n.source_type === 'comment')
      .map((n) => n.source_id);
    const raIds = Array.from(
      new Set(notifications.filter((n) => n.source_type === 'post').map((n) => n.actor_id).filter((id): id is string => !!id))
    );
    const [comments, raActors] = await Promise.all([
      commentIds.length
        ? ForumComment.findAll({ where: { id: { [Op.in]: commentIds } }, attributes: ['id', 'body', 'post_id', 'author_name'] })
        : [],
      raIds.length
        ? RAUser.findAll({ where: { ra_id: { [Op.in]: raIds } }, attributes: ['ra_id', 'display_name'] })
        : [],
    ]);
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const raNameById = new Map(raActors.map((a) => [String(a.ra_id), a.display_name]));

    const data = notifications.map((n) => {
      const comment = n.source_type === 'comment' ? commentById.get(n.source_id) : undefined;
      return {
        ...n.toJSON(),
        actor_name:
          n.source_type === 'comment'
            ? (comment?.author_name ?? null)
            : n.actor_id
              ? (raNameById.get(String(n.actor_id)) ?? null)
              : null,
        comment_body: comment?.body ?? null,
        post_id: comment?.post_id ?? null,
      };
    });

    return res.json({ success: true, data, unread_count: unreadCount });
  } catch (error: any) {
    console.error('get notifications error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /notifications/read-all — batch mark every unread notification read.
router.post('/read-all', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    await ForumNotification.update(
      { read_at: new Date() },
      { where: { user_id: req.identity!.id, user_type: req.identity!.type, read_at: null } }
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('mark all read error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /notifications/:id/read — mark one read.
router.post('/:id/read', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const notification = await ForumNotification.findOne({
      where: { id: Number(req.params.id), user_id: req.identity!.id, user_type: req.identity!.type },
    });
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    if (!notification.read_at) {
      await notification.update({ read_at: new Date() });
    }
    return res.json({ success: true });
  } catch (error: any) {
    console.error('mark notification read error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
