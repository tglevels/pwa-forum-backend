import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// One row per (post, viewer) — the unique index makes re-opening a post a
// no-op insert (caught in the route, not enforced as a DB error path), which
// is what keeps forum_posts.view_count a distinct-viewer count instead of a
// raw open-count.
export class ForumPostView extends Model {
  declare id: number;
  declare post_id: number;
  declare user_id: string;
  declare user_type: 'user' | 'ra';
}

ForumPostView.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    post_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.STRING, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'ra'), allowNull: false },
  },
  {
    sequelize,
    modelName: 'ForumPostView',
    tableName: 'forum_post_views',
    indexes: [{ unique: true, fields: ['post_id', 'user_id', 'user_type'] }],
  }
);
