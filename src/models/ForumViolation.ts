import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';
import { ForumComment } from './ForumComment';

// Policy-violation strikes, one row per offense. Counting is live today (it
// powers the phone-number warning); enforcing a block once strikes cross a
// threshold is a deliberate future step and will query this table.
export class ForumViolation extends Model {
  declare id: number;
  declare user_id: string;
  declare user_type: 'user' | 'ra';
  declare violation_type: 'phone_number' | 'link';
  declare comment_id: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ForumViolation.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.STRING, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'ra'), allowNull: false },
    violation_type: { type: DataTypes.ENUM('phone_number', 'link'), allowNull: false },
    comment_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: ForumComment, key: 'id' } },
  },
  {
    sequelize,
    modelName: 'ForumViolation',
    tableName: 'forum_user_violations',
    indexes: [{ fields: ['user_id', 'user_type', 'violation_type'] }],
  }
);
