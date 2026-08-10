import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumNotification } from '../models/ForumNotification';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

// GET /notifications — inbox for the bell icon. Supports ?since= for
// reconnect reconciliation.
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

    return res.json({ success: true, data: notifications, unread_count: unreadCount });
  } catch (error: any) {
    console.error('get notifications error:', error);
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
