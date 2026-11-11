import type { Role } from '@marafiq/shared';
import type { Request, RequestHandler } from 'express';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError, forbidden, unauthenticated } from '../../lib/http-error.js';
import { UserModel } from '../users/user.model.js';
import { ACCESS_COOKIE, readCookie } from './cookies.js';
import { isFamilyLive } from './sessions.service.js';
import { verifyAccessToken } from './tokens.js';

type AuthInfo = NonNullable<Request['auth']>;

/**
 * Resolve the signed-in user from the access cookie, or null.
 * The token alone is not trusted: the user must still be active and the login
 * not logged out, and the role comes from the database, not the token.
 */
export async function authenticate(req: Request, config: AppConfig): Promise<AuthInfo | null> {
  const token = readCookie(req.cookies, ACCESS_COOKIE);
  const claims = token ? verifyAccessToken(token, config) : null;
  if (!claims) return null;

  const [user, live] = await Promise.all([
    UserModel.findById(claims.userId).select('role active').lean(),
    isFamilyLive(claims.familyId),
  ]);
  if (!user || !user.active || !live) return null;
  return {
    userId: claims.userId,
    role: user.role as Role,
    mfa: claims.mfa,
    familyId: claims.familyId,
  };
}

export function makeAuthMiddleware(config: AppConfig) {
  /** 401 unless signed in. Admins must also have passed 2FA in this session. */
  const requireAuth: RequestHandler = async (req, _res, next) => {
    const auth = await authenticate(req, config);
    if (!auth) throw unauthenticated();
    if (auth.role === 'admin' && !auth.mfa) {
      throw new HttpError(
        403,
        '2fa_required',
        'Admin accounts must sign in with two-factor authentication',
      );
    }
    req.auth = auth;
    next();
  };

  /** 403 unless the signed-in user has one of the roles. Use after requireAuth. */
  const requireRole =
    (...roles: readonly Role[]): RequestHandler =>
    (req, _res, next) => {
      if (!req.auth) throw unauthenticated();
      if (!roles.includes(req.auth.role)) throw forbidden();
      next();
    };

  return { requireAuth, requireRole };
}
