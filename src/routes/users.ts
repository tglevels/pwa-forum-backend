import { Router, Response } from 'express';
import { Op } from 'sequelize';
import { ForumUser } from '../models/ForumUser';
import { requireAuth, AuthedRequest } from '../middleware/auth';

const router = Router();

// GET /users/search?q=<prefix> — backs the @mention autocomplete dropdown.
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
    return res.json({
      success: true,
      data: users.filter((u) => u.name).map((u) => ({ id: u.id, name: u.name })),
    });
  } catch (error: any) {
    console.error('user search error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
