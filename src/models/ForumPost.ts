import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

export class ForumPost extends Model {
  declare id: number;
  declare ra_id: string;
  declare community_id: string | null;
  declare title: string;
  declare body: string;
  declare status: 'published' | 'hidden';
  declare vote_count: number;
  declare comment_count: number;
  declare media_url: string | null;
  declare media_type: 'image' | 'video' | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ForumPost.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // No FK constraint: ra_users belongs to pwa-node-backend, a different
    // service's tables — this is a read-only cross-table reference.
    ra_id: { type: DataTypes.UUID, allowNull: false },
    community_id: { type: DataTypes.STRING, allowNull: true },
    title: { type: DataTypes.STRING, allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM('published', 'hidden'), defaultValue: 'published' },
    vote_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    comment_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    media_url: { type: DataTypes.STRING, allowNull: true },
    media_type: { type: DataTypes.ENUM('image', 'video'), allowNull: true },
  },
  { sequelize, modelName: 'ForumPost', tableName: 'forum_posts' }
);
