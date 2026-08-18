import { Router, Response } from 'express';
import { ForumTab } from '../models/ForumTab';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';

const router = Router();

function slugify(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'tab';
}

// 'new'/'trending' are unique enough as-is; a custom tab reusing one of those
// names (or colliding with another custom slug) gets a numeric suffix.
async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  while (await ForumTab.findOne({ where: { slug } })) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

// GET /tabs — public, active tabs ordered for the horizontal scroll bar.
// New/Trending are always sort_order 0/1 (pinned first/second at seed time)
// and are never reassigned a different sort_order via PATCH.
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const tabs = await ForumTab.findAll({ where: { is_active: true }, order: [['sort_order', 'ASC'], ['id', 'ASC']] });
    return res.json({ success: true, data: tabs });
  } catch (error: any) {
    console.error('get tabs error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /tabs — RA-created custom tab. Admin-gated. Unlimited count; new tabs
// are appended after whatever the current max sort_order is.
router.post('/', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    if (String(name).trim().length > 100) {
      return res.status(400).json({ success: false, message: 'Name is too long (max 100 characters)' });
    }

    const slug = await uniqueSlug(slugify(name));
    const maxOrder = await ForumTab.max('sort_order');
    const tab = await ForumTab.create({
      slug,
      name: String(name).trim(),
      type: 'custom',
      sort_order: (typeof maxOrder === 'number' ? maxOrder : 1) + 1,
      created_by: req.identity!.id,
    });

    return res.json({ success: true, data: tab });
  } catch (error: any) {
    console.error('create tab error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /tabs/:id — rename, reorder, or activate/deactivate. Admin-gated.
// System tabs (New/Trending) can't be renamed or deactivated — only custom
// tabs are mutable here, so their pinned first/second position is permanent.
router.patch('/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const tab = await ForumTab.findByPk(Number(req.params.id));
    if (!tab) {
      return res.status(404).json({ success: false, message: 'Tab not found' });
    }
    if (tab.type === 'system') {
      return res.status(400).json({ success: false, message: 'New/Trending cannot be modified' });
    }

    const { name, sort_order, is_active } = req.body;
    const updates: Partial<ForumTab> = {};
    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ success: false, message: 'name cannot be empty' });
      }
      updates.name = String(name).trim();
    }
    if (sort_order !== undefined) updates.sort_order = Number(sort_order);
    if (is_active !== undefined) updates.is_active = !!is_active;

    if (Object.keys(updates).length) await tab.update(updates);
    return res.json({ success: true, data: tab });
  } catch (error: any) {
    console.error('patch tab error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /tabs/:id — soft delete only (is_active=false). Historical
// forum_post_tabs rows are left untouched so old posts keep their tab
// association even after the tab drops out of the scroll bar; a future
// re-creation with the same name gets a fresh row (and slug), it never
// resurrects the hidden one.
router.delete('/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
  try {
    const tab = await ForumTab.findByPk(Number(req.params.id));
    if (!tab) {
      return res.status(404).json({ success: false, message: 'Tab not found' });
    }
    if (tab.type === 'system') {
      return res.status(400).json({ success: false, message: 'New/Trending cannot be deleted' });
    }
    await tab.update({ is_active: false });
    return res.json({ success: true, data: { id: tab.id } });
  } catch (error: any) {
    console.error('delete tab error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
