import { Router, Response } from 'express';
import { ForumPost } from '../models/ForumPost';
import { ForumComment } from '../models/ForumComment';
import { ForumVote } from '../models/ForumVote';
import { ForumViolation } from '../models/ForumViolation';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { sequelize } from '../config/database';

const router = Router();

// "Recent viewers" window — distinct from the all-time totals elsewhere on
// the page, which stay all-time.
const RECENT_VIEWER_WINDOW_DAYS = 3;

// Offset pagination for every list endpoint below. Defaults to 20 rows per
// page (the RA panel shows the first 20); callers override via ?page=N&limit=M.
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function pageParams(query: any): { page: number; limit: number; offset: number } {
  const page = Number.isFinite(Number(query?.page)) && Number(query.page) > 0 ? Math.floor(Number(query.page)) : 1;
  const limit =
    Number.isFinite(Number(query?.limit)) && Number(query.limit) > 0
      ? Math.min(Math.floor(Number(query.limit)), MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
  return { page, limit, offset: (page - 1) * limit };
}

function paginatedData<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) };
}

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3003';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

type Group = 'trial' | 'trial_extended' | 'paid' | 'trial_expired' | 'paid_expired' | 'unknown';

// Batch-classify user ids into their live trial/paid group via
// pwa-node-backend's /api/v1/trial-status — THE single source of truth every
// surface (push targeting, message visibility, RA panel) already reads from,
// rather than re-deriving the trial-day math here a second time. Fail-open to
// 'unknown' per id on any error — an analytics page must never 500 because
// the peer service hiccuped.
async function fetchGroupsByUserId(userIds: string[]): Promise<Map<string, Group>> {
  const out = new Map<string, Group>();
  const uniq = Array.from(new Set(userIds.filter(Boolean)));
  if (!uniq.length || !INTERNAL_API_KEY) return out;

  const CHUNK = 1000;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    try {
      const r = await fetch(`${BACKEND_URL}/api/v1/trial-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
        body: JSON.stringify({ user_ids: chunk }),
      });
      const j: any = await r.json();
      if (j?.success && j.data) {
        for (const id of chunk) {
          out.set(id, (j.data[id]?.group as Group) || 'unknown');
        }
      }
    } catch (err: any) {
      console.error('fetchGroupsByUserId: trial-status lookup failed (leaving as unknown):', err.message);
    }
  }
  return out;
}

// GET /overview — forum-wide totals, plus views broken down by trial/paid
// group ("how many views did paid users vs trial users generate").
router.get('/overview', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
  try {
    const [publishedPosts, hiddenPosts, totalComments, totalVotes, totalViolations] = await Promise.all([
      ForumPost.count({ where: { status: 'published' } }),
      ForumPost.count({ where: { status: 'hidden' } }),
      ForumComment.count({ where: { status: 'visible' } }),
      ForumVote.count(),
      ForumViolation.count(),
    ]);

    // One row per viewer with their view count — 'ra' views excluded, they
    // have no trial/paid group to bucket into. Stays all-time — only the
    // "Recent viewers" tile below is windowed.
    const viewRows: any[] = await sequelize.query(
      "SELECT user_id, COUNT(*) AS views FROM forum_post_views WHERE user_type = 'user' GROUP BY user_id",
      { type: 'SELECT' as any }
    );
    const totalViewEvents = viewRows.reduce((sum, r) => sum + Number(r.views), 0);

    // Recent viewers — distinct people who viewed anything in the last
    // RECENT_VIEWER_WINDOW_DAYS days, as opposed to total_unique_viewers'
    // predecessor, which counted everyone ever and never shrank.
    const recentViewerRows: any[] = await sequelize.query(
      `SELECT COUNT(DISTINCT user_id) AS n FROM forum_post_views
        WHERE user_type = 'user' AND createdAt >= NOW() - INTERVAL :days DAY`,
      { replacements: { days: RECENT_VIEWER_WINDOW_DAYS }, type: 'SELECT' as any }
    );
    const recentUniqueViewers = recentViewerRows[0]?.n;

    const groupByUserId = await fetchGroupsByUserId(viewRows.map((r) => String(r.user_id)));
    const viewsByGroup: Record<string, { viewers: number; views: number }> = {};
    for (const row of viewRows) {
      const group = groupByUserId.get(String(row.user_id)) || 'unknown';
      const bucket = viewsByGroup[group] ?? (viewsByGroup[group] = { viewers: 0, views: 0 });
      bucket.viewers += 1;
      bucket.views += Number(row.views);
    }

    return res.json({
      success: true,
      data: {
        total_posts: publishedPosts + hiddenPosts,
        published_posts: publishedPosts,
        hidden_posts: hiddenPosts,
        total_comments: totalComments,
        total_votes: totalVotes,
        total_violations: totalViolations,
        recent_unique_viewers: Number(recentUniqueViewers) || 0,
        recent_viewer_window_days: RECENT_VIEWER_WINDOW_DAYS,
        total_view_events: totalViewEvents,
        views_by_group: viewsByGroup,
      },
    });
  } catch (error: any) {
    console.error('forum analytics overview error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /viewers — forum-wide "who has seen this" list, backing the Recent
// Viewers / Views KPI tiles' drill-down (as opposed to GET /posts/:id, which
// scopes the same idea to a single post). ?days=N restricts to people who
// viewed something in the last N days, with their counts scoped to that same
// window (not lifetime) — a "recent" list should describe recent activity,
// not resurface someone's all-time total the moment they view once more.
// ?group= and ?user_type= additionally narrow by live trial/paid segment and
// account kind. Trial groups come from the cross-service lookup below, so the
// group/user-type filters + ordering + paging run in memory over the fully
// classified result set rather than in SQL.
router.get('/viewers', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const days = Number(req.query.days);
    const windowed = Number.isFinite(days) && days > 0;
    const { page, limit, offset } = pageParams(req.query);
    const q = String(req.query.q || '').trim();
    const groupFilter = String(req.query.group || '').trim();
    const userTypeFilter = String(req.query.user_type || '').trim();

    const whereClauses: string[] = [];
    const replacements: any = {};
    if (windowed) {
      whereClauses.push('v.createdAt >= NOW() - INTERVAL :days DAY');
      replacements.days = days;
    }
    if (q) {
      whereClauses.push('(u.phone LIKE :q OR v.user_id LIKE :q)');
      replacements.q = `%${q}%`;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows: any[] = await sequelize.query(
      `SELECT v.user_id, v.user_type, u.phone,
              COUNT(DISTINCT v.post_id) AS posts_viewed,
              COUNT(*) AS view_events,
              MIN(v.createdAt) AS first_viewed_at,
              MAX(v.createdAt) AS last_viewed_at
         FROM forum_post_views v
         LEFT JOIN users u ON u.user_id = v.user_id
        ${whereSql}
        GROUP BY v.user_id, v.user_type, u.phone`,
      { replacements, type: 'SELECT' as any }
    );

    const groupByUserId = await fetchGroupsByUserId(
      rows.filter((r) => r.user_type === 'user').map((r) => String(r.user_id))
    );

    let data = rows.map((r) => ({
      user_id: r.user_id,
      user_type: r.user_type,
      phone: r.phone || null,
      group: r.user_type === 'user' ? groupByUserId.get(String(r.user_id)) || 'unknown' : null,
      posts_viewed: Number(r.posts_viewed),
      view_events: Number(r.view_events),
      first_viewed_at: r.first_viewed_at,
      last_viewed_at: r.last_viewed_at,
    }));

    if (userTypeFilter === 'user' || userTypeFilter === 'ra') {
      data = data.filter((d) => d.user_type === userTypeFilter);
    }
    if (groupFilter) {
      data = data.filter((d) => d.group === groupFilter);
    }

    data.sort((a, b) => b.view_events - a.view_events);
    const total = data.length;
    const paged = data.slice(offset, offset + limit);

    return res.json({ success: true, data: paginatedData(paged, total, page, limit) });
  } catch (error: any) {
    console.error('forum analytics viewers error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /comments — recent comments with their post title, backing the Comments
// KPI tile's drill-down. Comment bodies have phone/link content stripped at
// write time, so they're safe to surface in the RA panel. ?q= searches the
// author/body/post title, ?status= narrows to visible/hidden, ?user_type= to
// user/ra.
router.get('/comments', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { page, limit, offset } = pageParams(req.query);
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const userType = String(req.query.user_type || '').trim();

    const whereClauses: string[] = [];
    const replacements: any = {};
    if (status === 'visible' || status === 'hidden') {
      whereClauses.push('c.status = :status');
      replacements.status = status;
    }
    if (userType === 'user' || userType === 'ra') {
      whereClauses.push('c.user_type = :userType');
      replacements.userType = userType;
    }
    if (q) {
      whereClauses.push('(c.author_name LIKE :q OR c.body LIKE :q OR c.user_id LIKE :q OR p.title LIKE :q)');
      replacements.q = `%${q}%`;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRow]: any[] = await sequelize.query(
      `SELECT COUNT(*) AS n
         FROM forum_comments c
         LEFT JOIN forum_posts p ON p.id = c.post_id
        ${whereSql}`,
      { replacements, type: 'SELECT' as any }
    );
    const total = Number(countRow?.n) || 0;

    const rows: any[] = await sequelize.query(
      `SELECT c.id, c.post_id, c.user_id, c.user_type, c.author_name, c.body,
              c.status, c.vote_count, c.is_pinned, c.createdAt,
              p.title AS post_title
         FROM forum_comments c
         LEFT JOIN forum_posts p ON p.id = c.post_id
        ${whereSql}
        ORDER BY c.createdAt DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset }, type: 'SELECT' as any }
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      post_id: Number(r.post_id),
      post_title: r.post_title || null,
      user_id: r.user_id,
      user_type: r.user_type,
      author_name: r.author_name || null,
      body: r.body,
      status: r.status,
      vote_count: Number(r.vote_count),
      is_pinned: Boolean(r.is_pinned),
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, data: paginatedData(data, total, page, limit) });
  } catch (error: any) {
    console.error('forum analytics comments error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /votes — recent votes with a human-readable target (post title or comment
// body), backing the Votes KPI tile's drill-down. ?target_type= narrows to
// post/comment votes, ?value= to 1 (up) / -1 (down), ?user_type= to user/ra.
// Name resolves the same way the violations route does it: users (user_id →
// phone) then ra_user_profiles (phone → display name).
router.get('/votes', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { page, limit, offset } = pageParams(req.query);
    const targetType = String(req.query.target_type || '').trim();
    const value = String(req.query.value || '').trim();
    const userType = String(req.query.user_type || '').trim();

    const whereClauses: string[] = [];
    const replacements: any = {};
    if (targetType === 'post' || targetType === 'comment') {
      whereClauses.push('v.target_type = :targetType');
      replacements.targetType = targetType;
    }
    if (value === '1' || value === '-1') {
      whereClauses.push('v.value = :value');
      replacements.value = Number(value);
    }
    if (userType === 'user' || userType === 'ra') {
      whereClauses.push('v.user_type = :userType');
      replacements.userType = userType;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRow]: any[] = await sequelize.query(
      `SELECT COUNT(*) AS n
         FROM forum_votes v
         LEFT JOIN forum_posts p ON v.target_type = 'post' AND p.id = v.target_id
         LEFT JOIN forum_comments c ON v.target_type = 'comment' AND c.id = v.target_id
        ${whereSql}`,
      { replacements, type: 'SELECT' as any }
    );
    const total = Number(countRow?.n) || 0;

    const rows: any[] = await sequelize.query(
      `SELECT v.id, v.user_id, v.user_type, v.target_type, v.target_id, v.value, v.createdAt,
              p.title AS post_title,
              c.body AS comment_body,
              u.phone,
              COALESCE(NULLIF(rup.name, ''), NULL) AS name
         FROM forum_votes v
         LEFT JOIN forum_posts p ON v.target_type = 'post' AND p.id = v.target_id
         LEFT JOIN forum_comments c ON v.target_type = 'comment' AND c.id = v.target_id
         LEFT JOIN users u ON u.user_id = v.user_id
         LEFT JOIN ra_user_profiles rup ON rup.phone = u.phone
        ${whereSql}
        ORDER BY v.createdAt DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset }, type: 'SELECT' as any }
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      user_id: r.user_id,
      user_type: r.user_type,
      target_type: r.target_type,
      target_id: Number(r.target_id),
      value: Number(r.value),
      post_title: r.post_title || null,
      comment_body: r.comment_body || null,
      phone: r.phone || null,
      name: r.name || null,
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, data: paginatedData(data, total, page, limit) });
  } catch (error: any) {
    console.error('forum analytics votes error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /violations — recent policy-violation strikes, backing the Violations KPI
// tile's drill-down. Comment bodies are stored redacted (phone/link stripped),
// so the snippet is safe to show. ?violation_type= narrows to phone_number/link,
// ?user_type= to user/ra, ?q= searches the phone / name / user id.
router.get('/violations', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { page, limit, offset } = pageParams(req.query);
    const q = String(req.query.q || '').trim();
    const violationType = String(req.query.violation_type || '').trim();
    const userType = String(req.query.user_type || '').trim();

    const whereClauses: string[] = [];
    const replacements: any = {};
    if (violationType === 'phone_number' || violationType === 'link') {
      whereClauses.push('v.violation_type = :violationType');
      replacements.violationType = violationType;
    }
    if (userType === 'user' || userType === 'ra') {
      whereClauses.push('v.user_type = :userType');
      replacements.userType = userType;
    }
    if (q) {
      whereClauses.push('(u.phone LIKE :q OR v.user_id LIKE :q OR rup.name LIKE :q)');
      replacements.q = `%${q}%`;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRow]: any[] = await sequelize.query(
      `SELECT COUNT(*) AS n
         FROM forum_user_violations v
         LEFT JOIN forum_comments c ON c.id = v.comment_id
         LEFT JOIN users u ON u.user_id = v.user_id
         LEFT JOIN ra_user_profiles rup ON rup.phone = u.phone
        ${whereSql}`,
      { replacements, type: 'SELECT' as any }
    );
    const total = Number(countRow?.n) || 0;

    const rows: any[] = await sequelize.query(
      `SELECT v.id, v.user_id, v.user_type, v.violation_type, v.comment_id, v.createdAt,
              c.body AS comment_body,
              u.phone,
              COALESCE(NULLIF(rup.name, ''), NULL) AS name
         FROM forum_user_violations v
         LEFT JOIN forum_comments c ON c.id = v.comment_id
         LEFT JOIN users u ON u.user_id = v.user_id
         LEFT JOIN ra_user_profiles rup ON rup.phone = u.phone
        ${whereSql}
        ORDER BY v.createdAt DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset }, type: 'SELECT' as any }
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      user_id: r.user_id,
      user_type: r.user_type,
      phone: r.phone || null,
      name: r.name || null,
      violation_type: r.violation_type,
      comment_id: r.comment_id ? Number(r.comment_id) : null,
      comment_body: r.comment_body || null,
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, data: paginatedData(data, total, page, limit) });
  } catch (error: any) {
    console.error('forum analytics violations error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts — per-post table: views, comments, votes, unique viewers. Kept
// light (no per-post group breakdown) so the list stays fast; drill into a
// single post via GET /posts/:id for the full viewer/group breakdown.
// ?status= (published/hidden), ?media_type= (image/video/none), ?is_pinned=
// (true/false) and ?q= (title search) let the RA trim the table before paging.
router.get('/posts', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { page, limit, offset } = pageParams(req.query);
    // sort=views (default) ranks by view count — what the RA opens this page
    // for; sort=newest keeps insertion order for the full-table browse.
    const sort = String(req.query.sort || 'views');
    const orderBy =
      sort === 'newest' ? 'p.id DESC' : 'COALESCE(vc.view_events, 0) DESC, p.id DESC';

    const status = String(req.query.status || '').trim();
    const mediaType = String(req.query.media_type || '').trim();
    const isPinned = String(req.query.is_pinned || '').trim();
    const q = String(req.query.q || '').trim();

    const whereClauses: string[] = [];
    const replacements: any = {};
    if (status === 'published' || status === 'hidden') {
      whereClauses.push('p.status = :status');
      replacements.status = status;
    }
    if (mediaType === 'image' || mediaType === 'video') {
      whereClauses.push('p.media_type = :mediaType');
      replacements.mediaType = mediaType;
    } else if (mediaType === 'none') {
      whereClauses.push('p.media_type IS NULL');
    }
    if (isPinned === 'true' || isPinned === 'false') {
      whereClauses.push('p.is_pinned = :isPinned');
      replacements.isPinned = isPinned === 'true';
    }
    if (q) {
      whereClauses.push('p.title LIKE :q');
      replacements.q = `%${q}%`;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRow]: any[] = await sequelize.query(
      `SELECT COUNT(*) AS n
         FROM forum_posts p
         LEFT JOIN (
           SELECT post_id, COUNT(DISTINCT user_id) AS unique_viewers, COUNT(*) AS view_events
             FROM forum_post_views
            GROUP BY post_id
         ) vc ON vc.post_id = p.id
        ${whereSql}`,
      { replacements, type: 'SELECT' as any }
    );
    const total = Number(countRow?.n) || 0;

    const rows: any[] = await sequelize.query(
      `SELECT p.id, p.title, p.status, p.media_type, p.is_pinned,
              p.vote_count, p.comment_count, p.view_count, p.createdAt,
              COALESCE(vc.unique_viewers, 0) AS unique_viewers,
              COALESCE(vc.view_events, 0) AS view_events
         FROM forum_posts p
         LEFT JOIN (
           SELECT post_id, COUNT(DISTINCT user_id) AS unique_viewers, COUNT(*) AS view_events
             FROM forum_post_views
            GROUP BY post_id
         ) vc ON vc.post_id = p.id
        ${whereSql}
        ORDER BY ${orderBy}
        LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset }, type: 'SELECT' as any }
    );

    const data = rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      status: r.status,
      media_type: r.media_type,
      is_pinned: Boolean(r.is_pinned),
      vote_count: Number(r.vote_count),
      comment_count: Number(r.comment_count),
      view_count: Number(r.view_count),
      unique_viewers: Number(r.unique_viewers),
      view_events: Number(r.view_events),
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, data: paginatedData(data, total, page, limit) });
  } catch (error: any) {
    console.error('forum analytics posts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /posts/:id — single-post drill-down: who viewed it (phone + live
// group), and this post's own group-wise view totals. The viewer list accepts
// ?q= (phone/name/user id search), ?group= (trial/paid segment), ?user_type=
// (user/ra) and ?vote_value= (1 up / -1 down / none). Trial groups come from
// the cross-service lookup, so those filters run in memory over the fully
// classified viewer set — the header group counts always reflect the whole
// post, not the current filter slice.
router.get('/posts/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const postId = Number(req.params.id);
    const post = await ForumPost.findByPk(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const { page, limit, offset } = pageParams(req.query);
    const q = String(req.query.q || '').trim().toLowerCase();
    const groupFilter = String(req.query.group || '').trim();
    const voteValueFilter = String(req.query.vote_value || '').trim();
    const userTypeFilter = String(req.query.user_type || '').trim();

    // users is the same physical DB this service already reads avatar_file
    // from — a plain LEFT JOIN, no cross-service call needed for the phone.
    // Name resolves the same way the RA message-stats route does it: users
    // (user_id → phone) then ra_user_profiles (phone → display name).
    // All viewers are fetched up front so the group/vote/query filters and
    // paging run over one fully-classified set, and the header totals below
    // stay true for the whole post.
    const allViewerRows: any[] = await sequelize.query(
      `SELECT v.user_id, v.user_type, v.createdAt AS viewed_at, u.phone,
              COALESCE(NULLIF(rup.name, ''), NULL) AS name
         FROM forum_post_views v
         LEFT JOIN users u ON u.user_id = v.user_id
         LEFT JOIN ra_user_profiles rup ON rup.phone = u.phone
        WHERE v.post_id = :postId
        ORDER BY v.createdAt DESC`,
      { replacements: { postId }, type: 'SELECT' as any }
    );

    const groupByUserId = await fetchGroupsByUserId(
      allViewerRows.filter((r) => r.user_type === 'user').map((r) => String(r.user_id))
    );
    const groupCounts: Record<string, number> = {};
    for (const r of allViewerRows) {
      const group = r.user_type === 'user' ? groupByUserId.get(String(r.user_id)) || 'unknown' : null;
      if (!group) continue;
      groupCounts[group] = (groupCounts[group] || 0) + 1;
    }

    // This post's votes (1/-1) keyed by voter, so each viewer row can show
    // whether that user upvoted, downvoted, or neither.
    const postVoteRows: any[] = await sequelize.query(
      "SELECT user_id, value FROM forum_votes WHERE target_type = 'post' AND target_id = :postId",
      { replacements: { postId }, type: 'SELECT' as any }
    );
    const voteByUser = new Map(postVoteRows.map((r) => [String(r.user_id), Number(r.value)]));

    let viewers = allViewerRows.map((r) => ({
      user_id: r.user_id,
      user_type: r.user_type,
      phone: r.phone || null,
      name: r.name || null,
      group: r.user_type === 'user' ? groupByUserId.get(String(r.user_id)) || 'unknown' : null,
      viewed_at: r.viewed_at,
      vote_value: voteByUser.get(String(r.user_id)) ?? null,
    }));

    if (userTypeFilter === 'user' || userTypeFilter === 'ra') {
      viewers = viewers.filter((v) => v.user_type === userTypeFilter);
    }
    if (groupFilter) {
      viewers = viewers.filter((v) => v.group === groupFilter);
    }
    if (voteValueFilter === '1') {
      viewers = viewers.filter((v) => v.vote_value === 1);
    } else if (voteValueFilter === '-1') {
      viewers = viewers.filter((v) => v.vote_value === -1);
    } else if (voteValueFilter === 'none') {
      viewers = viewers.filter((v) => v.vote_value === null);
    }
    if (q) {
      viewers = viewers.filter(
        (v) =>
          (v.name || '').toLowerCase().includes(q) ||
          (v.phone || '').toLowerCase().includes(q) ||
          v.user_id.toLowerCase().includes(q)
      );
    }

    const total = viewers.length;
    const pagedViewers = viewers.slice(offset, offset + limit);

    const [commentCount, voteRows] = await Promise.all([
      ForumComment.count({ where: { post_id: postId, status: 'visible' } }),
      ForumVote.findAll({ where: { target_type: 'post', target_id: postId }, attributes: ['value'] }),
    ]);
    const upvoteCount = voteRows.filter((v) => v.value === 1).length;
    const downvoteCount = voteRows.filter((v) => v.value === -1).length;

    return res.json({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        status: post.status,
        createdAt: post.createdAt,
        view_count: post.view_count,
        comment_count: commentCount,
        vote_count: post.vote_count,
        upvote_count: upvoteCount,
        downvote_count: downvoteCount,
        unique_viewers: total,
        group_counts: groupCounts,
        viewers: pagedViewers,
        total,
        page,
        limit,
        total_pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error: any) {
    console.error('forum analytics post detail error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
