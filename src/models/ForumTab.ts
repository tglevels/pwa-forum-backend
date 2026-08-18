import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// 'new' and 'trending' are seeded, protected rows (see ensureSystemTabs in
// index.ts) — RA can't rename/delete them, only reorder/create/deactivate
// custom ones. 'trending' is never a real bucket of posts (no forum_post_tabs
// rows ever reference it): its feed stays the existing computed ranking in
// posts.ts, this row only exists so it can appear in the tab bar via GET /tabs.
export class ForumTab extends Model {
  declare id: number;
  declare slug: string;
  declare name: string;
  declare type: 'system' | 'custom';
  declare is_active: boolean;
  declare sort_order: number;
  declare created_by: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ForumTab.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    slug: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.ENUM('system', 'custom'), allowNull: false, defaultValue: 'custom' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // No FK constraint, same cross-table-reference pattern as ForumPost.ra_id.
    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: 'ForumTab', tableName: 'forum_tabs' }
);
