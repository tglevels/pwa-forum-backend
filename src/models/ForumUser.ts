import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// Read-only mirror of pwa-node-backend's User model (table ra_user_profiles,
// despite the name — end-user accounts, not RAs). This service never writes
// to it, only reads display names for the @mention search endpoint (matched
// across to the `users` table by phone).
export class ForumUser extends Model {
  declare id: number;
  declare name: string | null;
  declare phone: string | null;
}

ForumUser.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: true },
    phone: { type: DataTypes.STRING, allowNull: true },
  },
  { sequelize, modelName: 'ForumUser', tableName: 'ra_user_profiles' }
);
