import { Router, Response } from 'express';
import { ForumVote } from '../models/ForumVote';
import { ForumPost } from '../models/ForumPost';
import { ForumComment } from '../models/ForumComment';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { sequelize } from '../config/database';

const router = Router();

// POST /votes — upsert on the unique (user_id, user_type, target_type, target_id)
// index; updates the denormalized vote_count in the same transaction.
// Sending value: 0 removes an existing vote (toggle-off from the client).
router.post('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const { target_type, target_id, value } = req.body;
    if (!['post', 'comment'].includes(target_type)) {
      return res.status(400).json({ success: false, message: 'target_type must be post or comment' });
    }
    const targetId = Number(target_id);
    const newValue = Number(value);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ success: false, message: 'target_id required' });
    }
    if (![1, -1, 0].includes(newValue)) {
      return res.status(400).json({ success: false, message: 'value must be 1, -1, or 0' });
    }

    const Model: any = target_type === 'post' ? ForumPost : ForumComment;
    const target = await Model.findByPk(targetId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'Target not found' });
    }

    const result = await sequelize.transaction(async (t) => {
      const existing = await ForumVote.findOne({
        where: {
          user_id: req.identity!.id,
          user_type: req.identity!.type,
          target_type,
          target_id: targetId,
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      const prevValue = existing?.value ?? 0;
      let delta = 0;

      if (newValue === 0) {
        if (existing) {
          await existing.destroy({ transaction: t });
          delta = -prevValue;
        }
      } else if (existing) {
        await existing.update({ value: newValue }, { transaction: t });
        delta = newValue - prevValue;
      } else {
        await ForumVote.create(
          { user_id: req.identity!.id, user_type: req.identity!.type, target_type, target_id: targetId, value: newValue },
          { transaction: t }
        );
        delta = newValue;
      }

      if (delta !== 0) {
        await (target as any).increment('vote_count', { by: delta, transaction: t });
      }
      await target.reload({ transaction: t });
      return target;
    });

    return res.json({ success: true, data: { target_type, target_id: targetId, vote_count: (result as any).vote_count, my_vote: newValue } });
  } catch (error: any) {
    console.error('vote error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
