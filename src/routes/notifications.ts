import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumNotification } from '../models/ForumNotification';
import { ForumComment } from '../models/ForumComment';
import { ForumUser } from '../models/ForumUser';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

// GET /notifications — inbox for the bell icon. Supports ?since= for
// reconnect reconciliation. Rows are enriched with the commenter's name and
// the tagged comment body so clients can render a useful preview without an
// extra round-trip per row.
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

    const actorIds = Array.from(
      new Set(notifications.map((n) => n.actor_id).filter((id): id is string => !!id))
    );
    const commentIds = notifications
      .filter((n) => n.source_type === 'comment')
      .map((n) => n.source_id);
    const [actors, comments] = await Promise.all([
      actorIds.length
        ? ForumUser.findAll({ where: { id: { [Op.in]: actorIds } }, attributes: ['id', 'name'] })
        : [],
      commentIds.length
        ? ForumComment.findAll({ where: { id: { [Op.in]: commentIds } }, attributes: ['id', 'body', 'post_id'] })
        : [],
    ]);
    const actorNames = new Map(actors.map((a) => [String(a.id), a.name]));
    const commentById = new Map(comments.map((c) => [c.id, c]));

    const data = notifications.map((n) => {
      const comment = n.source_type === 'comment' ? commentById.get(n.source_id) : undefined;
      return {
        ...n.toJSON(),
        actor_name: n.actor_id ? actorNames.get(String(n.actor_id)) ?? null : null,
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
