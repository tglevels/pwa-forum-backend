import fs from 'fs';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { DataTypes } from 'sequelize';
import { sequelize } from './config/database';
import { RAUser } from './models/RAUser';
import { ForumUser } from './models/ForumUser';
import { ForumUserAccount } from './models/ForumUserAccount';
import { ForumPost } from './models/ForumPost';
import { ForumComment } from './models/ForumComment';
import { ForumVote } from './models/ForumVote';
import { ForumPostView } from './models/ForumPostView';
import { ForumNotification } from './models/ForumNotification';
import { ForumViolation } from './models/ForumViolation';
import { ForumTab } from './models/ForumTab';
import { ForumPostTab } from './models/ForumPostTab';

// forum_comments predates the is_pinned column — sync() only creates missing
// tables, so add it by hand the first time it's absent. Additive-only, never
// touches existing rows/columns.
async function ensureForumCommentPinnedColumn() {
  const qi = sequelize.getQueryInterface();
  const columns = await qi.describeTable('forum_comments');
  if (!columns.is_pinned) {
    await qi.addColumn('forum_comments', 'is_pinned', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }
}

// forum_posts predates the media/pin columns — sync() only creates missing
// tables, so add these by hand the first time they're absent. Additive-only,
// never touches existing rows/columns.
async function ensureForumPostMediaColumns() {
  const qi = sequelize.getQueryInterface();
  const columns = await qi.describeTable('forum_posts');
  if (!columns.media_url) {
    await qi.addColumn('forum_posts', 'media_url', { type: DataTypes.STRING, allowNull: true });
  }
  if (!columns.media_type) {
    await qi.addColumn('forum_posts', 'media_type', { type: DataTypes.ENUM('image', 'video'), allowNull: true });
  }
  if (!columns.view_count) {
    await qi.addColumn('forum_posts', 'view_count', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  }
}

// forum_user_violations predates the 'link' violation type — sync() never
// alters an existing enum column, so widen it by hand (additive only).
async function ensureViolationTypeEnum() {
  const qi = sequelize.getQueryInterface();
  const columns = await qi.describeTable('forum_user_violations');
  if (!columns.violation_type) return;
  const type = columns.violation_type.type;
  const enumSql = String(type);
  if (enumSql.includes('link')) return;
  await qi.changeColumn('forum_user_violations', 'violation_type', {
    type: DataTypes.ENUM('phone_number', 'link'),
    allowNull: false,
  });
  if (!columns.is_pinned) {
    await qi.addColumn('forum_posts', 'is_pinned', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }
}

// Seed the two pinned system tabs once, idempotently. 'trending' never
// collects forum_post_tabs rows (its feed stays the computed ranking in
// posts.ts) — the row only exists so GET /tabs can list it in the bar.
async function ensureSystemTabs() {
  await ForumTab.findOrCreate({
    where: { slug: 'new' },
    defaults: { slug: 'new', name: 'New', type: 'system', sort_order: 0 },
  });
  await ForumTab.findOrCreate({
    where: { slug: 'trending' },
    defaults: { slug: 'trending', name: 'Trending', type: 'system', sort_order: 1 },
  });
}

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
};

// Custom path so nginx can proxy this service's socket.io under
// /forum-socket.io/ on a shared domain without colliding with
// pwa-node-backend's socket.io at the default /socket.io/ path.
const io = new Server(server, { path: '/forum-socket.io/', cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json());
app.set('io', io);

// Post media (images/video) and preset avatars, both served at /upload/<file>
// — post media from the forum service's own 'upload' folder (singular —
// distinct from pwa-node-backend's '/uploads' chat attachments), avatars from
// the 'avatars' folder. Single route so every caller only needs one path.
app.use('/upload', express.static('upload', { maxAge: '30d', immutable: true }));
app.use('/upload', express.static('avatars', { maxAge: '30d', immutable: true }));

// multer's diskStorage doesn't create its destination directory — make sure the
// 'upload' folder exists on boot (cwd-relative, matching the multer/static
// paths) so the first media upload doesn't crash with ENOENT.
fs.mkdirSync('upload', { recursive: true });

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-local-dev';
const FORUM_JWT_SECRET = process.env.FORUM_JWT_SECRET || 'fallback-forum-user-secret';

// Handshake auth: verify the same JWTs as the REST middleware. A client can
// only join its own `user:{userId}` room — hard requirement here (unlike
// pwa-node-backend's public community rooms) because that room carries
// private mention/notification pushes.
function identityFromToken(token: string | undefined): { id: string; type: 'user' | 'ra' } | null {
  if (!token) return null;
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded?.user?.id) return { id: decoded.user.id, type: 'ra' };
  } catch { /* try the other secret */ }
  try {
    const decoded: any = jwt.verify(token, FORUM_JWT_SECRET);
    if (decoded?.user_id) return { id: String(decoded.user_id), type: 'user' };
  } catch { /* neither secret matched */ }
  return null;
}

io.use((socket: Socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  const identity = identityFromToken(token);
  // Anonymous sockets are still allowed — they can view `feed`/`post:*` rooms
  // (public), just never `user:{userId}` (checked again on join_user_room).
  (socket.data as any).identity = identity;
  next();
});

io.on('connection', (socket) => {
  socket.on('join_feed', () => {
    socket.join('feed');
  });

  socket.on('join_post', (postId: string | number) => {
    if (postId) socket.join(`post:${postId}`);
  });

  socket.on('leave_post', (postId: string | number) => {
    if (postId) socket.leave(`post:${postId}`);
  });

  // Private notification room — only joinable by the authenticated owner.
  socket.on('join_user_room', () => {
    const identity = (socket.data as any).identity;
    if (identity?.id) socket.join(`user:${identity.id}`);
  });
});

import postsRoutes from './routes/posts';
import votesRoutes from './routes/votes';
import notificationsRoutes from './routes/notifications';
import usersRoutes from './routes/users';
import tabsRoutes from './routes/tabs';
import analyticsRoutes from './routes/analytics';

app.use('/api/v1/forum/posts', postsRoutes);
app.use('/api/v1/forum/votes', votesRoutes);
app.use('/api/v1/forum/notifications', notificationsRoutes);
app.use('/api/v1/forum/users', usersRoutes);
app.use('/api/v1/forum/tabs', tabsRoutes);
app.use('/api/v1/forum/analytics', analyticsRoutes);

const PORT = process.env.PORT || 3005;

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('Forum DB connected.');
    // Registering RAUser/ForumUser (no sync — read-only, owned by
    // pwa-node-backend) plus this service's own models. sync() only ever
    // creates missing tables here, never touches ra_users/ra_user_profiles/etc.
    void RAUser;
    void ForumUser;
    void ForumUserAccount;
    await Promise.all([ForumPost.sync()]);
    await ensureForumPostMediaColumns();
    await Promise.all([ForumComment.sync(), ForumVote.sync(), ForumPostView.sync(), ForumNotification.sync()]);
    // After ForumComment (it has an FK reference to forum_comments).
    await ForumViolation.sync();
    await ensureViolationTypeEnum();

    await ensureForumCommentPinnedColumn();

    await ForumTab.sync();
    await ensureSystemTabs();
    // After ForumTab/ForumPost (it FK-references both).
    await ForumPostTab.sync();

    server.listen(PORT, () => {
      console.log(`Forum service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
}

startServer();
