import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// Read-only mirror of the mobile PWA's end-user `users` table (one row per
// registered device). This service never writes to it. `user_id` is the SAME
// namespace the session cookie / forum JWT carries (e.g. "JPD70G") — every
// in-app notification row must be keyed on it so GET /notifications (queried
// by the token's user_id) lines up with mention/post fan-out.
export class ForumUserAccount extends Model {
  declare id: number;
  declare user_id: string | null;
  declare phone: string;
}

ForumUserAccount.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.STRING, allowNull: true },
    phone: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, modelName: 'ForumUserAccount', tableName: 'users' }
);
