import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { RAUser } from '../models/RAUser';

// Same secret pwa-node-backend signs RA JWTs with — verified statelessly here.
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-local-dev';
// Separate secret for short-lived end-user tokens minted by tglevel_mobile_pwa.
const FORUM_JWT_SECRET = process.env.FORUM_JWT_SECRET || 'fallback-forum-user-secret';
export const ADMIN_PHONE = (process.env.RA_ADMIN_PHONE || '9999999999').trim();

export interface ForumIdentity {
  id: string;
  type: 'user' | 'ra';
  display_name?: string;
}

export interface AuthedRequest extends Request {
  identity?: ForumIdentity;
}

// Accepts either an RA token (signed with JWT_SECRET, { user: { id, ... } })
// or an end-user forum token (signed with FORUM_JWT_SECRET, { user_id, role }).
// Whichever secret verifies first wins — the two are never valid for both.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const token = header.slice(7);

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded?.user?.id) {
      req.identity = { id: decoded.user.id, type: 'ra', display_name: decoded.user.display_name };
      return next();
    }
  } catch {
    // fall through to try the user secret
  }

  try {
    const decoded: any = jwt.verify(token, FORUM_JWT_SECRET);
    if (decoded?.user_id) {
      req.identity = { id: String(decoded.user_id), type: 'user' };
      return next();
    }
  } catch {
    // neither secret matched
  }

  return res.status(401).json({ success: false, message: 'Invalid or expired token' });
}

// Shared admin check (DB-backed, not token-trusted) reused by requireAdmin
// and by routes that need to branch on admin-vs-owner without a hard 403,
// e.g. "admin OR the comment's own author may delete it".
export async function isAdminIdentity(identity?: ForumIdentity): Promise<boolean> {
  if (identity?.type !== 'ra') return false;
  const ra = await RAUser.findByPk(identity.id);
  return !!ra && ra.status === 'active' && String(ra.phone_number).trim() === ADMIN_PHONE;
}

// Admin = the RA whose phone_number matches RA_ADMIN_PHONE, checked against the
// DB (not the token) — mirrors pwa-node-backend's requireAdmin exactly, since
// this service can't reuse that middleware in-process.
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!(await isAdminIdentity(req.identity))) {
      return res.status(403).json({ success: false, message: 'Only the admin RA can perform this action' });
    }
    return next();
  } catch (error: any) {
    console.error('requireAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}
