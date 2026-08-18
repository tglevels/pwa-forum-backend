import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumPost } from '../models/ForumPost';
import { ForumPostView } from '../models/ForumPostView';
import { ForumComment } from '../models/ForumComment';
import { ForumVote } from '../models/ForumVote';
import { ForumNotification } from '../models/ForumNotification';
import { ForumViolation } from '../models/ForumViolation';
import { ForumUserAccount } from '../models/ForumUserAccount';
import { RAUser } from '../models/RAUser';
import { ForumTab } from '../models/ForumTab';
import { ForumPostTab } from '../models/ForumPostTab';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { notifyNewPost } from '../lib/notify';
import { sanitizeForumBody, sanitizeForumTitle, plainTextLength } from '../lib/sanitizeForumHtml';
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

  // Upvote/downvote split for each post, computed in one pass over the vote
  // table so the RA dashboard can show both counts instead of the net score.
  const postIds = posts.map((p) => p.id);
  const voteRows = postIds.length
    ? await ForumVote.findAll({
        where: { target_type: 'post', target_id: { [Op.in]: postIds } },
        attributes: ['target_id', 'value'],
      })
    : [];
  const votesById = new Map<number, { up: number; down: number }>();
  for (const v of voteRows) {
    const cur = votesById.get(v.target_id) ?? { up: 0, down: 0 };
    if (v.value === 1) cur.up += 1;
    else if (v.value === -1) cur.down += 1;
    votesById.set(v.target_id, cur);
  }

  // Tabs a post belongs to (never includes 'trending' — that's computed, not
  // a bucket). Batched in one pass so the feed list doesn't do N+1 lookups.
  const postTabRows = postIds.length
    ? await ForumPostTab.findAll({ where: { post_id: { [Op.in]: postIds } } })
    : [];
  const tabIds = Array.from(new Set(postTabRows.map((r) => r.tab_id)));
  const tabs = tabIds.length ? await ForumTab.findAll({ where: { id: { [Op.in]: tabIds } } }) : [];
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const tabsByPostId = new Map<number, { id: number; slug: string; name: string }[]>();
  for (const row of postTabRows) {
    const tab = tabById.get(row.tab_id);
    if (!tab) continue;
    const list = tabsByPostId.get(row.post_id) ?? [];
    list.push({ id: tab.id, slug: tab.slug, name: tab.name });
    tabsByPostId.set(row.post_id, list);
  }

  return posts.map((p) => {
    const author = authorById.get(p.ra_id);
    const votes = votesById.get(p.id) ?? { up: 0, down: 0 };
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
      upvote_count: votes.up,
      downvote_count: votes.down,
      comment_count: p.comment_count,
      view_count: p.view_count,
      media_url: p.media_url,
      media_type: p.media_type,
      is_pinned: p.is_pinned,
      tabs: tabsByPostId.get(p.id) ?? [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

// Resolve the tab_ids a new post should be filed under. Empty/omitted input
// defaults to just the 'new' system tab; 'trending' is silently dropped if
// ever passed since it's never a real bucket. Invalid/unknown ids are dropped
// rather than rejected, so a stale client payload can't fail the whole post.
async function resolvePostTabIds(requested: unknown): Promise<number[]> {
  const requestedIds = Array.isArray(requested)
    ? requested.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : [];

  if (!requestedIds.length) {
    const newTab = await ForumTab.findOne({ where: { slug: 'new' } });
    return newTab ? [newTab.id] : [];
  }

  const tabs = await ForumTab.findAll({ where: { id: { [Op.in]: requestedIds }, is_active: true } });
  return tabs.filter((t) => t.slug !== 'trending').map((t) => t.id);
}

// POST /posts — RA composer only (TG-RA-Frontend). Admin-gated. Accepts an
// optional multipart "media" field (image or video) alongside title/body.
router.post('/', requireAuth, requireAdmin, upload.single('media'), async (req: AuthedRequest, res: Response) => {
  try {
    const { title, body, community_id } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body are required' });
    }
    // multipart/form-data can't send a real array, so the composer sends
    // tab_ids as a JSON string; a normal JSON body may already send an array.
    let requestedTabIds: unknown = req.body.tab_ids;
    if (typeof requestedTabIds === 'string') {
      try {
        requestedTabIds = JSON.parse(requestedTabIds);
      } catch {
        requestedTabIds = [requestedTabIds];
      }
    }
    if (plainTextLength(String(title)) > 500) {
      return res.status(400).json({ success: false, message: 'Title is too long (max 500 characters)' });
    }

    const file = req.file;
    const media_url = file ? `/upload/${file.filename}` : null;
    const media_type = file ? (file.mimetype.startsWith('video') ? 'video' : 'image') : null;

    const post = await ForumPost.create({
      ra_id: req.identity!.id,
      community_id: community_id || null,
      title: sanitizeForumTitle(String(title)),
      body: sanitizeForumBody(String(body)),
      status: 'published',
      media_url,
      media_type,
    });

    const tabIds = await resolvePostTabIds(requestedTabIds);
    if (tabIds.length) {
      await ForumPostTab.bulkCreate(tabIds.map((tab_id) => ({ post_id: post.id, tab_id })));
    }

    const author = await RAUser.findByPk(req.identity!.id);
    const io = req.app.get('io');
    const serialized = (await serializePosts([post]))[0];
    io.to('feed').emit('post:new', serialized);

    // In-app inbox: every end user gets a "new post" row so their bell badge
    // and notification list reflect it. Rows are keyed on the `users` table's
    // user_id (the SAME namespace the forum JWT carries — ra_user_profiles.id
    // is a different identity space and would never match a user's inbox
    // query). Chunked bulk insert so a large user base doesn't blow the
    // connection buffer; fan-out is non-critical, so a failure here must not
    // fail the post itself.
    try {
      const accounts = await ForumUserAccount.findAll({ attributes: ['user_id'] });
      const userIds = Array.from(
        new Set(accounts.map((a) => String(a.user_id)).filter((id) => !!id && id !== 'undefined' && id !== 'null'))
      );
      if (userIds.length) {
        const CHUNK = 500;
        const actorId = req.identity!.id;
        for (let i = 0; i < userIds.length; i += CHUNK) {
          await ForumNotification.bulkCreate(
            userIds.slice(i, i + CHUNK).map((userId) => ({
              user_id: userId,
              user_type: 'user' as const,
              type: 'new_post' as const,
              source_type: 'post' as const,
              source_id: post.id,
              actor_id: actorId,
            }))
          );
        }
      }
    } catch (err) {
      console.warn('[posts] new_post notification fan-out failed (non-fatal):', (err as Error).message);
    }

    // Live badge bump for everyone currently on the feed. id is null because a
    // broadcast has no single owner row — the client reconciles real rows (and
    // exact unread count) with GET /notifications on page open/reconnect.
    io.to('feed').emit('notification:new', {
      type: 'new_post',
      source_type: 'post',
      source_id: post.id,
      post_id: post.id,
      id: null,
      read_at: null,
      actor_name: author?.display_name ?? 'RA',
      createdAt: post.createdAt,
    });

    notifyNewPost({
      id: post.id,
      title: post.title,
      ra_display_name: author?.display_name,
      media_url: post.media_url,
      media_type: post.media_type,
    });

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
    const { since, cursor, limit, sort, tab } = req.query;
    const capped = Math.min(Number(limit) || 20, 50);

    if (sort === 'trending' || tab === 'trending') {
      const trendingLimit = Math.min(Number(limit) || 10, 50);
      const windowStart = new Date(Date.now() - TRENDING_WINDOW_DAYS * 86400000);
      const candidates = await ForumPost.findAll({
        where: { status: 'published', createdAt: { [Op.gte]: windowStart } },
        order: [['id', 'DESC']],
        limit: 300,
      });
      const ranked = candidates
        .slice()
        .sort((a, b) => trendingScore(b) - trendingScore(a))
        .slice(0, trendingLimit);
      return res.json({ success: true, data: await serializePosts(ranked) });
    }

    const where: any = { status: 'published' };
    if (since) {
      where.createdAt = { [Op.gt]: new Date(String(since)) };
    } else if (cursor) {
      where.id = { [Op.lt]: Number(cursor) };
    }

    // ?tab=<slug> scopes the feed to posts filed under a specific tab (custom
    // tab, or 'new' — which is just every post, same as no filter, since
    // every post gets 'new' by default). Unknown slug -> empty result rather
    // than silently falling back to the unfiltered feed.
    let tabPostIds: number[] | null = null;
    if (tab && tab !== 'new') {
      const tabRow = await ForumTab.findOne({ where: { slug: String(tab) } });
      if (!tabRow) {
        return res.json({ success: true, data: [] });
      }
      const rows = await ForumPostTab.findAll({ where: { tab_id: tabRow.id }, attributes: ['post_id'] });
      tabPostIds = rows.map((r) => r.post_id);
      if (!tabPostIds.length) {
        return res.json({ success: true, data: [] });
      }
      where.id = { ...(where.id ?? {}), [Op.in]: tabPostIds };
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

// POST /posts/:id/view — record a distinct view. Idempotent per (post,
// viewer): a repeat open of the same post by the same identity increments
// nothing, so view_count reflects distinct viewers rather than raw opens.
router.post('/:id/view', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const post = await ForumPost.findByPk(postId);
    if (!post || post.status === 'hidden') {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const view_count = await sequelize.transaction(async (t) => {
      const [, created] = await ForumPostView.findOrCreate({
        where: { post_id: postId, user_id: req.identity!.id, user_type: req.identity!.type },
        transaction: t,
      });
      if (created) {
        await post.increment('view_count', { by: 1, transaction: t });
        await post.reload({ transaction: t });
      }
      return post.view_count;
    });

    return res.json({ success: true, data: { post_id: postId, view_count } });
  } catch (error: any) {
    console.error('record view error:', error);
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
    if (title !== undefined && plainTextLength(String(title)) > 500) {
      return res.status(400).json({ success: false, message: 'Title is too long (max 500 characters)' });
    }

    const updates: Partial<ForumPost> = {};
    if (status) updates.status = status;
    if (title !== undefined) updates.title = sanitizeForumTitle(String(title));
    if (body !== undefined) updates.body = sanitizeForumBody(String(body));

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
      updates.media_url = `/upload/${file.filename}`;
      updates.media_type = file.mimetype.startsWith('video') ? 'video' : 'image';
    }

    if (Object.keys(updates).length) await post.update(updates);

    // tab_ids is optional and, when present, fully replaces the post's tab
    // assignments (not merged) — same shape as the composer's create form.
    if (req.body.tab_ids !== undefined) {
      let requestedTabIds: unknown = req.body.tab_ids;
      if (typeof requestedTabIds === 'string') {
        try {
          requestedTabIds = JSON.parse(requestedTabIds);
        } catch {
          requestedTabIds = [requestedTabIds];
        }
      }
      const tabIds = await resolvePostTabIds(requestedTabIds);
      await ForumPostTab.destroy({ where: { post_id: post.id } });
      if (tabIds.length) {
        await ForumPostTab.bulkCreate(tabIds.map((tab_id) => ({ post_id: post.id, tab_id })));
      }
    }

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
        // comment_id is a nullable FK with no ON DELETE CASCADE — null it out
        // rather than deleting the violation rows, so a user's strike count
        // (used for future block-on-threshold enforcement) survives the
        // comment/post being removed.
        await ForumViolation.update(
          { comment_id: null },
          { where: { comment_id: { [Op.in]: commentIds } }, transaction: t }
        );
        await ForumComment.destroy({ where: { post_id: post.id }, transaction: t });
      }

      await ForumVote.destroy({ where: { target_type: 'post', target_id: post.id }, transaction: t });
      await ForumNotification.destroy({ where: { source_type: 'post', source_id: post.id }, transaction: t });
      await ForumPostTab.destroy({ where: { post_id: post.id }, transaction: t });
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
