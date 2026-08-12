import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumUser } from '../models/ForumUser';
import { ForumUserAccount } from '../models/ForumUserAccount';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { OFFICIAL_HANDLE } from '../lib/officialHandle';

const router = Router();

// GET /users/search?q=<prefix> — backs the @mention autocomplete dropdown.
// Returns the session-uid namespace (`users.user_id`, e.g. "JPD70G") as `id`
// — NOT ra_user_profiles.id — because mention notifications and the inbox are
// both keyed on the user_id the forum JWT carries. Display names come from
// ra_user_profiles, matched across to `users` by phone. The official
// @Tglevels handle is pinned to the top when it matches, and any real user
// who shares the reserved name is overridden.
router.get('/search', requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ success: true, data: [] });
    }
    const profiles = await ForumUser.findAll({
      where: { name: { [Op.like]: `${q}%` } },
      limit: 20,
      attributes: ['phone', 'name'],
    });
    const phones = Array.from(new Set(profiles.map((p) => String(p.phone)).filter(Boolean)));
    const accounts = phones.length
      ? await ForumUserAccount.findAll({
          where: { phone: { [Op.in]: phones } },
          attributes: ['phone', 'user_id'],
        })
      : [];
    const uidByPhone = new Map(accounts.map((a) => [String(a.phone), String(a.user_id)]));

    const matchesOfficial = new RegExp(`^${OFFICIAL_HANDLE.name.slice(0, 1)}`, 'i').test(q);
    const data: Array<{ id: string; name: string }> = [];
    for (const p of profiles) {
      const id = p.name ? uidByPhone.get(String(p.phone)) : undefined;
      if (!id || id === 'undefined' || id === 'null') continue;
      if (String(p.name).toLowerCase() === OFFICIAL_HANDLE.name.toLowerCase()) continue;
      data.push({ id, name: p.name! });
      if (data.length >= 10) break;
    }
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
