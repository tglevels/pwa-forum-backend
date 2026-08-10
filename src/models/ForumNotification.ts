import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

export class ForumNotification extends Model {
  declare id: number;
  declare user_id: string;
  declare user_type: 'user' | 'ra';
  declare type: 'mention' | 'new_post';
  declare source_type: 'post' | 'comment';
  declare source_id: number;
  declare actor_id: string | null;
  declare read_at: Date | null;
  declare createdAt: Date;
}

ForumNotification.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.STRING, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'ra'), allowNull: false },
    type: { type: DataTypes.ENUM('mention', 'new_post'), allowNull: false },
    source_type: { type: DataTypes.ENUM('post', 'comment'), allowNull: false },
    source_id: { type: DataTypes.INTEGER, allowNull: false },
    actor_id: { type: DataTypes.STRING, allowNull: true },
    read_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    modelName: 'ForumNotification',
    tableName: 'forum_notifications',
    updatedAt: false,
    indexes: [{ fields: ['user_id', 'user_type', 'read_at'] }],
  }
);
