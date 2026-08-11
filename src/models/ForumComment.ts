import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';
import { ForumPost } from './ForumPost';

export class ForumComment extends Model {
  declare id: number;
  declare post_id: number;
  declare parent_comment_id: number | null;
  declare user_id: string;
  declare user_type: 'user' | 'ra';
  // Cosmetic display label only (not identity — user_id/user_type from the
  // verified JWT are what authorship checks use). Denormalized at write time
  // so the forum service never needs a cross-service profile lookup to render
  // a comment list.
  declare author_name: string | null;
  declare body: string;
  declare vote_count: number;
  declare status: 'visible' | 'hidden';
  declare is_pinned: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ForumComment.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    post_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: ForumPost, key: 'id' } },
    parent_comment_id: { type: DataTypes.INTEGER, allowNull: true },
    user_id: { type: DataTypes.STRING, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'ra'), allowNull: false },
    author_name: { type: DataTypes.STRING, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: false },
    vote_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    status: { type: DataTypes.ENUM('visible', 'hidden'), defaultValue: 'visible' },
    is_pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { sequelize, modelName: 'ForumComment', tableName: 'forum_comments' }
);

// Same-service FK is fine (both tables owned by this service).
ForumComment.belongsTo(ForumPost, { foreignKey: 'post_id' });
ForumComment.belongsTo(ForumComment, { foreignKey: 'parent_comment_id', as: 'parent' });
