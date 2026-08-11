import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumPost } from '../models/ForumPost';
import { ForumComment } from '../models/ForumComment';
import { ForumVote } from '../models/ForumVote';
import { ForumNotification } from '../models/ForumNotification';

import { requireAuth, isAdminIdentity, AuthedRequest ,ADMIN_PHONE } from '../middleware/auth';
import { extractMentions } from '../lib/mentions';
import { notifyMention, notifyOfficialMention } from '../lib/notify';
import { OFFICIAL_HANDLE, containsOfficialMention } from '../lib/officialHandle';
import { containsPhoneNumber, stripPhoneNumbers } from '../lib/phoneGuard';
import { containsLink, stripLinks } from '../lib/linkGuard';
import { ForumViolation } from '../models/ForumViolation';
import { RAUser } from '../models/RAUser';
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
    is_pinned: c.is_pinned,
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

    const rawBody = String(body);
    // Content guards: phone numbers and links are redacted before storage, and
    // a violation strike is recorded per offense. The client also reports when
    // it stripped either itself (phone_stripped / link_stripped) so strikes
    // accumulate for compliant clients too — detection here covers
    // bypassing/API traffic.
    const phoneDetected = containsPhoneNumber(rawBody) || req.body.phone_stripped === true;
    const linkDetected = containsLink(rawBody) || req.body.link_stripped === true;
    // Only rewrite the body when offending content is actually present — the
    // flags alone (client stripped it) must not alter otherwise-clean text.
    let storedBody = rawBody;
    if (containsPhoneNumber(rawBody)) storedBody = stripPhoneNumbers(storedBody);
    if (containsLink(rawBody)) storedBody = stripLinks(storedBody);

    if (parent_comment_id) {
      const parent = await ForumComment.findByPk(Number(parent_comment_id));
      if (!parent || parent.post_id !== postId) {
        return res.status(400).json({ success: false, message: 'Invalid parent_comment_id' });
      }
    }

    const { comment, phoneStrikes, linkStrikes } = await sequelize.transaction(async (t) => {
      const created = await ForumComment.create(
        {
          post_id: postId,
          parent_comment_id: parent_comment_id ? Number(parent_comment_id) : null,
          user_id: req.identity!.id,
          user_type: req.identity!.type,
          author_name: author_name ? String(author_name).slice(0, 120) : null,
          body: storedBody,
        },
        { transaction: t }
      );
      await post.increment('comment_count', { by: 1, transaction: t });

      let strikes = 0;
      if (phoneDetected) {
        await ForumViolation.create(
          {
            user_id: req.identity!.id,
            user_type: req.identity!.type,
            violation_type: 'phone_number',
            comment_id: created.id,
          },
          { transaction: t }
        );
        strikes = await ForumViolation.count({
          where: { user_id: req.identity!.id, user_type: req.identity!.type, violation_type: 'phone_number' },
          transaction: t,
        });
      }
      let linkStrikes = 0;
      if (linkDetected) {
        await ForumViolation.create(
          {
            user_id: req.identity!.id,
            user_type: req.identity!.type,
            violation_type: 'link',
            comment_id: created.id,
          },
          { transaction: t }
        );
        linkStrikes = await ForumViolation.count({
          where: { user_id: req.identity!.id, user_type: req.identity!.type, violation_type: 'link' },
          transaction: t,
        });
      }
      return { comment: created, phoneStrikes: strikes, linkStrikes };
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
    const rawMentionedIds = Array.from(new Set([...extractMentions(comment.body), ...explicitIds]))
      .filter((id) => id !== req.identity!.id)
      .slice(0, 10);
    // @Tglevels is a reserved official handle (id can never equal a numeric
    // user id). Detect it case-insensitively from the id list AND the body
    // text (covers bypassing clients), then notify the admin RA instead of an
    // end user — the official account has no user row to notify.
    const officialMentioned =
      rawMentionedIds.some((id) => id.toLowerCase() === OFFICIAL_HANDLE.id) ||
      containsOfficialMention(comment.body);
    const mentionedIds = rawMentionedIds.filter((id) => id.toLowerCase() !== OFFICIAL_HANDLE.id);
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
        commentBody: comment.body,
        actorName: comment.author_name || undefined,
      });
    }
    if (officialMentioned) {
      const adminRa = await RAUser.findOne({ where: { phone_number: ADMIN_PHONE, status: 'active' } });
      if (adminRa) {
        await ForumNotification.create({
          user_id: adminRa.ra_id,
          user_type: 'ra',
          type: 'mention',
          source_type: 'comment',
          source_id: comment.id,
          actor_id: req.identity!.id,
        });
        io.to(`user:${adminRa.ra_id}`).emit('notification:new', {
          type: 'mention',
          mention: 'official',
          post_id: postId,
          comment_id: comment.id,
          actor_name: comment.author_name,
        });
        notifyOfficialMention({
          adminRaId: adminRa.ra_id,
          postId,
          commentId: comment.id,
          actorName: comment.author_name || undefined,
        });
      } else {
        console.warn('[comments] @Tglevels mentioned but no active admin RA found to notify');
      }
    }

    const payload: any = { success: true, data: serialized };
    if (phoneDetected) {
      payload.warning = {
        type: 'phone_number',
        strikes: phoneStrikes,
        // Exposed for the client, but NOT enforced yet — blocking commenting
        // after repeated strikes is a deliberate future step.
        strike_limit: Number(process.env.FORUM_PHONE_STRIKE_LIMIT) || 3,
      };
    } else if (linkDetected) {
      payload.warning = {
        type: 'link',
        strikes: linkStrikes,
        // Exposed for the client, but NOT enforced yet — blocking commenting
        // after repeated strikes is a deliberate future step.
        strike_limit: Number(process.env.FORUM_LINK_STRIKE_LIMIT) || 3,
      };
    }
    return res.json(payload);
  } catch (error: any) {
    console.error('create comment error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts/:id/comments — public flat fetch; client builds the tree from
// parent_comment_id. Pinned comments float to the top of the list so every
// viewer sees them stuck to the top of the thread (Instagram-style).
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const comments = await ForumComment.findAll({
      where: { post_id: postId, status: 'visible' },
      order: [
        ['is_pinned', 'DESC'],
        ['id', 'ASC'],
      ],
      limit: 500,
    });
    return res.json({ success: true, data: comments.map(serializeComment) });
  } catch (error: any) {
    console.error('get comments error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /posts/:id/comments/:commentId — two independent, separately-gated
// updates share this route: pinning (`is_pinned`, admin-only, same rule as
// post pinning) and editing the comment's own text (`body`, author-only —
// a user may only edit their own comment, admin or not). Broadcasts the
// update to the post room so open clients move it live without a refetch.
router.patch('/:commentId', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const comment = await ForumComment.findOne({ where: { id: Number(req.params.commentId), post_id: postId } });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const wantsPin = Object.prototype.hasOwnProperty.call(req.body, 'is_pinned');
    const wantsBodyEdit = Object.prototype.hasOwnProperty.call(req.body, 'body');
    if (!wantsPin && !wantsBodyEdit) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const updates: { is_pinned?: boolean; body?: string } = {};

    if (wantsPin) {
      if (!(await isAdminIdentity(req.identity))) {
        return res.status(403).json({ success: false, message: 'Only the admin RA can pin comments' });
      }
      const pinRequested = req.body.is_pinned === true || req.body.is_pinned === 'true';
      if (pinRequested && comment.parent_comment_id !== null) {
        return res.status(400).json({ success: false, message: 'Only top-level comments can be pinned' });
      }
      if (pinRequested && !comment.is_pinned) {
        const pinnedCount = await ForumComment.count({ where: { post_id: postId, is_pinned: true } });
        if (pinnedCount >= 3) {
          return res.status(400).json({ success: false, message: 'Only 3 comments can be pinned per post' });
        }
      }
      updates.is_pinned = pinRequested;
    }

    if (wantsBodyEdit) {
      const isOwner = comment.user_id === req.identity!.id && comment.user_type === req.identity!.type;
      if (!isOwner) {
        return res.status(403).json({ success: false, message: 'You can only edit your own comment' });
      }
      const newBody = String(req.body.body || '').trim();
      if (!newBody) {
        return res.status(400).json({ success: false, message: 'body is required' });
      }
      updates.body = newBody;
    }

    await comment.update(updates);

    const serialized = serializeComment(comment);
    const io = req.app.get('io');
    io.to(`post:${postId}`).emit('comment:updated', serialized);

    return res.json({ success: true, data: serialized });
  } catch (error: any) {
    console.error('update comment error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /posts/:id/comments/:commentId — permanently remove a comment plus
// any nested replies, their votes and notifications. Allowed for the admin
// RA (moderation) or the comment's own author (self-delete), same pattern
// as post deletion (no ON DELETE CASCADE, so dependents are cleaned up in a
// transaction first).
router.delete('/:commentId', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const comment = await ForumComment.findOne({ where: { id: Number(req.params.commentId), post_id: postId } });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    const isOwner = comment.user_id === req.identity!.id && comment.user_type === req.identity!.type;
    if (!isOwner && !(await isAdminIdentity(req.identity))) {
      return res.status(403).json({ success: false, message: 'You can only delete your own comment' });
    }

    await sequelize.transaction(async (t) => {
      // Replies can nest arbitrarily deep, so walk the tree breadth-first to
      // collect every descendant id, not just the immediate children.
      const commentIds = [comment.id];
      let frontier = [comment.id];
      while (frontier.length) {
        const children = await ForumComment.findAll({
          where: { parent_comment_id: { [Op.in]: frontier } },
          attributes: ['id'],
          transaction: t,
        });
        frontier = children.map((c) => c.id);
        commentIds.push(...frontier);
      }

      await ForumVote.destroy({ where: { target_type: 'comment', target_id: { [Op.in]: commentIds } }, transaction: t });
      await ForumNotification.destroy({ where: { source_type: 'comment', source_id: { [Op.in]: commentIds } }, transaction: t });
      await ForumComment.destroy({ where: { id: { [Op.in]: commentIds } }, transaction: t });
      await ForumPost.decrement('comment_count', { by: commentIds.length, where: { id: postId }, transaction: t });
    });

    const io = req.app.get('io');
    io.to(`post:${postId}`).emit('comment:deleted', { id: comment.id, post_id: postId });

    return res.json({ success: true, data: { id: comment.id } });
  } catch (error: any) {
    console.error('delete comment error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
