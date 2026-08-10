import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumPost } from '../models/ForumPost';
import { RAUser } from '../models/RAUser';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { notifyNewPost } from '../lib/notify';
import { upload } from '../lib/upload';
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
      media_url: p.media_url,
      media_type: p.media_type,
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

// GET /posts — feed. Public (per §1, reads don't require the user JWT).
// Supports ?since=<ISO timestamp> for reconnect reconciliation.
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { since, cursor, limit } = req.query;
    const where: any = { status: 'published' };
    if (since) {
      where.createdAt = { [Op.gt]: new Date(String(since)) };
    } else if (cursor) {
      where.id = { [Op.lt]: Number(cursor) };
    }

    const posts = await ForumPost.findAll({
      where,
      order: [['id', 'DESC']],
      limit: Math.min(Number(limit) || 20, 50),
    });

    return res.json({ success: true, data: await serializePosts(posts) });
  } catch (error: any) {
    console.error('get posts error:', error);
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

// PATCH /posts/:id — hide/moderate. Admin-gated.
router.patch('/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const post = await ForumPost.findByPk(Number(req.params.id));
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const { status } = req.body;
    if (status && !['published', 'hidden'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    if (status) await post.update({ status });

    return res.json({ success: true, data: (await serializePosts([post]))[0] });
  } catch (error: any) {
    console.error('patch post error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
