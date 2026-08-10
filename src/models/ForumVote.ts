import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

export class ForumVote extends Model {
  declare id: number;
  declare user_id: string;
  declare user_type: 'user' | 'ra';
  declare target_type: 'post' | 'comment';
  declare target_id: number;
  declare value: number; // -1 or 1
}

ForumVote.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.STRING, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'ra'), allowNull: false },
    target_type: { type: DataTypes.ENUM('post', 'comment'), allowNull: false },
    target_id: { type: DataTypes.INTEGER, allowNull: false },
    value: { type: DataTypes.TINYINT, allowNull: false },
  },
  {
    sequelize,
    modelName: 'ForumVote',
    tableName: 'forum_votes',
    indexes: [
      { unique: true, fields: ['user_id', 'user_type', 'target_type', 'target_id'] },
    ],
  }
);
