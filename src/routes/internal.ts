import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { ForumPost } from '../models/ForumPost';
import { publishPost } from './posts';

const router = Router();

// Service-to-service only, guarded by a shared key — same pattern
// pwa-node-backend's /api/v1/trial-status uses. Never reachable by an RA JWT
// or a user JWT, only by another backend that holds INTERNAL_API_KEY.
function requireInternalKey(req: Request, res: Response, next: () => void) {
  const key = req.headers['x-internal-key'];
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// POST /internal/publish-due-scheduled — called by PWA_NOTIFY's cron (see
// that service's schedulers/publishScheduledForumPosts.js), not on any timer
// of this service's own. A post created with a future scheduled_for sits as
// status='scheduled' (invisible to every public read — see posts.ts) until
// this notices its time has arrived and runs it through the same
// publishPost() immediate-publish and "publish now" use. Safe to call as
// often as the caller likes — re-reads current state each time rather than
// tracking pending timers, so a reschedule/cancel in between calls is always
// respected.
router.post('/publish-due-scheduled', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const io = req.app.get('io');
    const due = await ForumPost.findAll({
      where: { status: 'scheduled', scheduled_for: { [Op.lte]: new Date() } },
    });

    const published: number[] = [];
    const failed: { id: number; error: string }[] = [];
    for (const post of due) {
      try {
        await publishPost(io, post, post.ra_id);
        published.push(post.id);
      } catch (err: any) {
        failed.push({ id: post.id, error: err.message });
      }
    }

    return res.json({ success: true, checked: due.length, published, failed });
  } catch (error: any) {
    console.error('publish-due-scheduled error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
