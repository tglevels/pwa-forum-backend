import multer from 'multer';
import path from 'path';
import crypto from 'crypto';

// Same disk-storage pattern as pwa-node-backend's messages.ts: random filename,
// original extension kept so it's served with the right MIME type.
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image or video files are allowed'));
    }
  },
});
