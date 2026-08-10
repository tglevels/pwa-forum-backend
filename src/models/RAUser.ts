import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/database';

// Read-only mirror of pwa-node-backend's RAUser model — this service never
// writes to ra_users, only reads it for the admin check and display names.
export class RAUser extends Model {
  declare ra_id: string;
  declare display_name: string;
  declare phone_number: string;
  declare status: string;
  declare profile_picture: string | null;
}

RAUser.init(
  {
    ra_id: { type: DataTypes.UUID, primaryKey: true },
    display_name: { type: DataTypes.STRING, allowNull: false },
    phone_number: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: 'active' },
    profile_picture: { type: DataTypes.STRING, allowNull: true },
  },
  {
    sequelize,
    tableName: 'ra_users',
    timestamps: true,
  }
);
