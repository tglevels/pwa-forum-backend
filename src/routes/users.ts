import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumUser } from '../models/ForumUser';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { OFFICIAL_HANDLE } from '../lib/officialHandle';

const router = Router();

// GET /users/search?q=<prefix> — backs the @mention autocomplete dropdown.
// The official @Tglevels handle is pinned to the top when it matches, and any
// real user who shares the reserved name is overridden (the keyword always
// resolves to the official account).
router.get('/search', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ success: true, data: [] });
    }
    const users = await ForumUser.findAll({
      where: { name: { [Op.like]: `${q}%` } },
      limit: 10,
      attributes: ['id', 'name'],
    });
    const matchesOfficial = new RegExp(`^${OFFICIAL_HANDLE.name.slice(0, 1)}`, 'i').test(q);
    const data: Array<{ id: string; name: string }> = users
      .filter((u) => u.name)
      .filter((u) => String(u.name).toLowerCase() !== OFFICIAL_HANDLE.name.toLowerCase())
      .map((u) => ({ id: String(u.id), name: u.name! }));
    if (matchesOfficial) {
      data.unshift({ id: OFFICIAL_HANDLE.id, name: OFFICIAL_HANDLE.name });
    }
    return res.json({ success: true, data: data.slice(0, 10) });
  } catch (error: any) {
    console.error('user search error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
