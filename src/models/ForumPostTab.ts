import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// Many-to-many: a post can sit in several tabs at once. 'trending' never gets
// a row here — it's always the computed ranking in posts.ts, not a bucket.
export class ForumPostTab extends Model {
  declare id: number;
  declare post_id: number;
  declare tab_id: number;
}

ForumPostTab.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    post_id: { type: DataTypes.INTEGER, allowNull: false },
    tab_id: { type: DataTypes.INTEGER, allowNull: false },
  },
  {
    sequelize,
    modelName: 'ForumPostTab',
    tableName: 'forum_post_tabs',
    indexes: [
      { unique: true, fields: ['post_id', 'tab_id'] },
      { fields: ['tab_id'] },
    ],
  }
);
