import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumPost } from '../models/ForumPost';
import { ForumPostView } from '../models/ForumPostView';
import { ForumComment } from '../models/ForumComment';
import { ForumVote } from '../models/ForumVote';
import { ForumNotification } from '../models/ForumNotification';
import { RAUser } from '../models/RAUser';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { notifyNewPost } from '../lib/notify';
import { upload } from '../lib/upload';
import { sequelize } from '../config/database';
import commentsRouter from './comments';

const router = Router();

// Comments live under a post: /posts/:id/comments
router.use('/:id/comments', commentsRouter);

async function serializePosts(posts: ForumPost[]) {
  const raIds = Array.from(new Set(posts.map((p) => p.ra_id)));
  const authors = raIds.length
    ? await RAUser.findAll({ where: { ra_id: { [Op.in]: raIds } } })
    : [];
  const authorById = new Map(authors.map((a) => [a.ra_id, a]));
  return posts.map((p) => {
    const author = authorById.get(p.ra_id);
    return {
      id: p.id,
      ra_id: p.ra_id,
      author_name: author?.display_name || 'RA',
      author_avatar: author?.profile_picture || null,
      community_id: p.community_id,
      title: p.title,
      body: p.body,
      status: p.status,
      vote_count: p.vote_count,
      comment_count: p.comment_count,
      view_count: p.view_count,
      media_url: p.media_url,
      media_type: p.media_type,
      is_pinned: p.is_pinned,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

// POST /posts — RA composer only (TG-RA-Frontend). Admin-gated. Accepts an
// optional multipart "media" field (image or video) alongside title/body.
router.post('/', requireAuth, requireAdmin, upload.single('media'), async (req: AuthedRequest, res: Response) => {
  try {
    const { title, body, community_id } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body are required' });
    }

    const file = req.file;
    const media_url = file ? `/uploads/${file.filename}` : null;
    const media_type = file ? (file.mimetype.startsWith('video') ? 'video' : 'image') : null;

    const post = await ForumPost.create({
      ra_id: req.identity!.id,
      community_id: community_id || null,
      title: String(title).slice(0, 500),
      body: String(body),
      status: 'published',
      media_url,
      media_type,
    });

    const author = await RAUser.findByPk(req.identity!.id);
    const io = req.app.get('io');
    const serialized = (await serializePosts([post]))[0];
    io.to('feed').emit('post:new', serialized);

    notifyNewPost({ id: post.id, title: post.title, ra_display_name: author?.display_name });

    return res.json({ success: true, data: serialized });
  } catch (error: any) {
    console.error('create post error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Trending candidates are drawn from this window so the ranking stays about
// "what's hot lately", not "best post of all time" (which decay alone would
// eventually surface again as older top posts' scores decay toward zero
// anyway, but restricting the pool keeps the query cheap as the table grows).
const TRENDING_WINDOW_DAYS = 14;

// Reddit/HN-style decayed engagement score: comments weigh most (strongest
// engagement signal), views least (cheapest, easiest to rack up passively).
// The (age + 2)^1.5 denominator lets a post decay out of trending within a
// couple of days even if it never stops accumulating views.
function trendingScore(post: ForumPost): number {
  const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / 3600000;
  const engagement = post.vote_count * 2 + post.comment_count * 3 + post.view_count * 0.5;
  return engagement / Math.pow(Math.max(ageHours, 0) + 2, 1.5);
}

// GET /posts — feed. Public (per §1, reads don't require the user JWT).
// Supports ?since=<ISO timestamp> for reconnect reconciliation, and
// ?sort=trending for the decayed-engagement ranking instead of chronological
// (trending ignores since/cursor — it's always a fresh top-N, not a page).
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { since, cursor, limit, sort } = req.query;
    const capped = Math.min(Number(limit) || 20, 50);

    if (sort === 'trending') {
      const windowStart = new Date(Date.now() - TRENDING_WINDOW_DAYS * 86400000);
      const candidates = await ForumPost.findAll({
        where: { status: 'published', createdAt: { [Op.gte]: windowStart } },
        order: [['id', 'DESC']],
        limit: 300,
      });
      const ranked = candidates
        .slice()
        .sort((a, b) => trendingScore(b) - trendingScore(a))
        .slice(0, capped);
      return res.json({ success: true, data: await serializePosts(ranked) });
    }

    const where: any = { status: 'published' };
    if (since) {
      where.createdAt = { [Op.gt]: new Date(String(since)) };
    } else if (cursor) {
      where.id = { [Op.lt]: Number(cursor) };
    }

    let pinned: ForumPost[] = [];
    if (!cursor) {
      pinned = await ForumPost.findAll({
        where: { ...where, is_pinned: true },
        order: [['id', 'DESC']],
      });
    }

    const pinnedIds = pinned.map((p) => p.id);
    const rest = await ForumPost.findAll({
      where: {
        ...where,
        is_pinned: false,
        ...(pinnedIds.length ? { id: { ...where.id, [Op.notIn]: pinnedIds } } : {}),
      },
      order: [['id', 'DESC']],
      limit: capped,
    });

    return res.json({ success: true, data: await serializePosts([...pinned, ...rest]) });
  } catch (error: any) {
    console.error('get posts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts/admin/all — moderation list for the RA dashboard: every post
// (published + hidden) with pinned posts floated to the top, so a hidden post
// stays in the list and can be toggled back to published. Admin-gated; the
// public mobile feed keeps using /posts.
router.get('/admin/all', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { limit } = req.query;
    const take = Math.min(Number(limit) || 50, 100);

    const pinned = await ForumPost.findAll({ where: { is_pinned: true }, order: [['id', 'DESC']] });
    const pinnedIds = pinned.map((p) => p.id);
    const restWhere: any = {};
    if (pinnedIds.length) restWhere.id = { [Op.notIn]: pinnedIds };
    const rest = await ForumPost.findAll({ where: restWhere, order: [['id', 'DESC']], limit: take });

    return res.json({ success: true, data: await serializePosts([...pinned, ...rest]) });
  } catch (error: any) {
    console.error('get all posts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts/:id — single post.
router.get('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const post = await ForumPost.findByPk(Number(req.params.id));
    if (!post || post.status === 'hidden') {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    return res.json({ success: true, data: (await serializePosts([post]))[0] });
  } catch (error: any) {
    console.error('get post error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /posts/:id — hide/moderate, or edit title/body/media. Admin-gated.
// A new "media" file replaces the existing attachment; omitting it keeps
// whatever the post already had (same optional-replace pattern as the
// banner module's updateBanner).
router.patch('/:id', requireAuth, requireAdmin, upload.single('media'), async (req: AuthedRequest, res: Response) => {
  try {
    const post = await ForumPost.findByPk(Number(req.params.id));
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const { status, title, body, is_pinned } = req.body;
    if (status && !['published', 'hidden'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const updates: Partial<ForumPost> = {};
    if (status) updates.status = status;
    if (title !== undefined) updates.title = String(title).slice(0, 500);
    if (body !== undefined) updates.body = String(body);

    // Cap at 3 pinned posts (WhatsApp-style) — enforce on the DB side so the
    // RA UI and the mobile app can't drift past it.
    const pinRequested = is_pinned === true || is_pinned === 'true';
    if (is_pinned !== undefined) {
      if (!pinRequested) {
        updates.is_pinned = false;
      } else {
        const pinnedCount = await ForumPost.count({ where: { is_pinned: true, id: { [Op.ne]: post.id } } });
        if (pinnedCount >= 3) {
          return res.status(400).json({ success: false, message: 'Maximum 3 posts can be pinned at a time' });
        }
        updates.is_pinned = true;
      }
    }

    const file = req.file;
    if (file) {
      updates.media_url = `/uploads/${file.filename}`;
      updates.media_type = file.mimetype.startsWith('video') ? 'video' : 'image';
    }

    if (Object.keys(updates).length) await post.update(updates);

    const serialized = (await serializePosts([post]))[0];
    if ('is_pinned' in updates) {
      const io = req.app.get('io');
      io.to('feed').emit('post:updated', serialized);
    }

    return res.json({ success: true, data: serialized });
  } catch (error: any) {
    console.error('patch post error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /posts/:id — permanently remove a post plus its comments, votes and
// notifications. Admin-gated. There's no ON DELETE CASCADE (the FKs are
// hand-written), so clean up dependents in a transaction before removing it.
router.delete('/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const post = await ForumPost.findByPk(Number(req.params.id));
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    await sequelize.transaction(async (t) => {
      const comments = await ForumComment.findAll({
        where: { post_id: post.id },
        attributes: ['id'],
        transaction: t,
      });
      const commentIds = comments.map((c) => c.id);

      if (commentIds.length) {
        await ForumVote.destroy({ where: { target_type: 'comment', target_id: { [Op.in]: commentIds } }, transaction: t });
        await ForumNotification.destroy({ where: { source_type: 'comment', source_id: { [Op.in]: commentIds } }, transaction: t });
        await ForumComment.destroy({ where: { post_id: post.id }, transaction: t });
      }

      await ForumVote.destroy({ where: { target_type: 'post', target_id: post.id }, transaction: t });
      await ForumNotification.destroy({ where: { source_type: 'post', source_id: post.id }, transaction: t });
      await post.destroy({ transaction: t });
    });

    // Drop it from the live feed room.
    const io = req.app.get('io');
    io.to('feed').emit('post:deleted', { id: post.id });

    return res.json({ success: true, data: { id: post.id } });
  } catch (error: any) {
    console.error('delete post error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
