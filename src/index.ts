import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { DataTypes } from 'sequelize';
import { sequelize } from './config/database';
import { RAUser } from './models/RAUser';
import { ForumUser } from './models/ForumUser';
import { ForumPost } from './models/ForumPost';
import { ForumComment } from './models/ForumComment';
import { ForumVote } from './models/ForumVote';
import { ForumPostView } from './models/ForumPostView';
import { ForumNotification } from './models/ForumNotification';
import { ForumViolation } from './models/ForumViolation';

// forum_posts predates the media/view_count columns — sync() only creates
// missing tables, so add these by hand the first time they're absent.
// Additive-only, never touches existing rows/columns.
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
}

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json());
app.set('io', io);

// Post media (images/video), served at /uploads/<file> — same static-serve
// pattern as pwa-node-backend's chat attachments.
app.use('/uploads', express.static('uploads', { maxAge: '30d', immutable: true }));

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

app.use('/api/v1/forum/posts', postsRoutes);
app.use('/api/v1/forum/votes', votesRoutes);
app.use('/api/v1/forum/notifications', notificationsRoutes);
app.use('/api/v1/forum/users', usersRoutes);

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
    await Promise.all([ForumPost.sync()]);
    await ensureForumPostMediaColumns();
    await Promise.all([ForumComment.sync(), ForumVote.sync(), ForumPostView.sync(), ForumNotification.sync()]);
    // After ForumComment (it has an FK reference to forum_comments).
    await ForumViolation.sync();
    await ensureViolationTypeEnum();

    server.listen(PORT, () => {
      console.log(`Forum service listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
}

startServer();
