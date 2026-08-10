import { Router, Response } from 'express';
import { ForumPost } from '../models/ForumPost';
import { ForumComment } from '../models/ForumComment';
import { ForumNotification } from '../models/ForumNotification';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { extractMentions } from '../lib/mentions';
import { notifyMention } from '../lib/notify';
import { sequelize } from '../config/database';

const router = Router({ mergeParams: true });

function serializeComment(c: ForumComment) {
  return {
    id: c.id,
    post_id: c.post_id,
    parent_comment_id: c.parent_comment_id,
    user_id: c.user_id,
    user_type: c.user_type,
    author_name: c.author_name,
    body: c.body,
    vote_count: c.vote_count,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// POST /posts/:id/comments — user JWT (or RA JWT for admin replies).
router.post('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const post = await ForumPost.findByPk(postId);
    if (!post || post.status === 'hidden') {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const { body, parent_comment_id, author_name } = req.body;
    if (!body || !String(body).trim()) {
      return res.status(400).json({ success: false, message: 'body is required' });
    }

    if (parent_comment_id) {
      const parent = await ForumComment.findByPk(Number(parent_comment_id));
      if (!parent || parent.post_id !== postId) {
        return res.status(400).json({ success: false, message: 'Invalid parent_comment_id' });
      }
    }

    const comment = await sequelize.transaction(async (t) => {
      const created = await ForumComment.create(
        {
          post_id: postId,
          parent_comment_id: parent_comment_id ? Number(parent_comment_id) : null,
          user_id: req.identity!.id,
          user_type: req.identity!.type,
          author_name: author_name ? String(author_name).slice(0, 120) : null,
          body: String(body),
        },
        { transaction: t }
      );
      await post.increment('comment_count', { by: 1, transaction: t });
      return created;
    });

    const io = req.app.get('io');
    const serialized = serializeComment(comment);
    io.to(`post:${postId}`).emit('comment:new', serialized);

    // @mentions → in-app notification + push, excluding self-mentions.
    // Two sources: raw "@user_id" tokens typed in the body (legacy), and an
    // explicit id list the autocomplete UI sends out-of-band since it inserts
    // a readable "@Name" into the visible text rather than a raw id.
    const explicitIds = Array.isArray(req.body.mentioned_user_ids)
      ? req.body.mentioned_user_ids.map((id: any) => String(id)).slice(0, 10)
      : [];
    const mentionedIds = Array.from(new Set([...extractMentions(comment.body), ...explicitIds]))
      .filter((id) => id !== req.identity!.id)
      .slice(0, 10);
    for (const mentionedUserId of mentionedIds) {
      await ForumNotification.create({
        user_id: mentionedUserId,
        user_type: 'user',
        type: 'mention',
        source_type: 'comment',
        source_id: comment.id,
        actor_id: req.identity!.id,
      });
      io.to(`user:${mentionedUserId}`).emit('notification:new', {
        type: 'mention',
        post_id: postId,
        comment_id: comment.id,
        actor_name: comment.author_name,
      });
      notifyMention({
        mentionedUserId,
        postId,
        commentId: comment.id,
        actorName: comment.author_name || undefined,
      });
    }

    return res.json({ success: true, data: serialized });
  } catch (error: any) {
    console.error('create comment error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts/:id/comments — public flat fetch; client builds the tree from
// parent_comment_id.
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const comments = await ForumComment.findAll({
      where: { post_id: postId, status: 'visible' },
      order: [['id', 'ASC']],
      limit: 500,
    });
    return res.json({ success: true, data: comments.map(serializeComment) });
  } catch (error: any) {
    console.error('get comments error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
